/**
 * Transport tests for the browser client: authentication, request routing,
 * reconnect/backoff, liveness probing and resubscribe — all driven against an
 * in-memory socket and a controllable clock, so they are fast and headless.
 */

import { describe, expect, it } from "vitest";
import { APP_SCRIPT } from "./script/app.js";
import { MODEL_SCRIPT } from "./script/model.js";
import { type ClientOptions, FakeSocket, loadWebClient } from "./test-helpers/load.js";

const { model, app } = loadWebClient();

/** A hand-cranked clock, so backoff is observed rather than waited out. */
class FakeClock {
  #next = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();
  now = 0;

  readonly setTimeout = (fn: () => void, ms: number): number => {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.#timers.delete(handle);
  };

  /** Advance time, firing everything that comes due, then flush microtasks. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let earliest: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at > target) continue;
        if (!earliest || entry[1].at < earliest[1].at) earliest = entry;
      }
      if (!earliest) break;
      this.#timers.delete(earliest[0]);
      this.now = earliest[1].at;
      earliest[1].fn();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }

  /** Delays still armed, smallest first. */
  pending(): number[] {
    return [...this.#timers.values()].map((timer) => timer.at - this.now).sort((a, b) => a - b);
  }
}

interface Harness {
  clock: FakeClock;
  sockets: FakeSocket[];
  client: ReturnType<typeof app.createClient>;
  statuses: string[];
  ready: number;
  events: { sessionId: string; type: string }[];
  latest(): FakeSocket;
}

function harness(overrides: Partial<ClientOptions> = {}): Harness {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const state = { ready: 0 };
  const events: { sessionId: string; type: string }[] = [];
  const client = app.createClient({
    url: "ws://127.0.0.1:9/",
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    // Mid-point randomness cancels the jitter term exactly, so the delays
    // asserted below are the pure exponential schedule.
    random: () => 0.5,
    probeIntervalMs: 0,
    onStatus: (status) => statuses.push(status),
    onReady: () => {
      state.ready += 1;
    },
    onEvent: (sessionId, event) => events.push({ sessionId, type: event.type }),
    ...overrides,
  });
  const result: Harness = {
    clock,
    sockets,
    client,
    statuses,
    get ready() {
      return state.ready;
    },
    events,
    latest: () => sockets[sockets.length - 1] as FakeSocket,
  };
  return result;
}

/** Complete the handshake on the newest socket. */
async function authenticate(test: Harness): Promise<void> {
  test.latest().open();
  await Promise.resolve();
  const frame = test.latest().last;
  test.latest().deliver({ kind: "response", id: frame?.id, result: { authenticated: true } });
  await Promise.resolve();
  await Promise.resolve();
}

describe("web client transport: authentication", () => {
  it("sends the shared token as the first frame and comes online", async () => {
    const test = harness({ token: "s3cret" });
    test.client.connect();
    test.latest().open();
    await Promise.resolve();

    expect(test.latest().sent).toHaveLength(1);
    expect(test.latest().sent[0]).toMatchObject({
      method: "authenticate",
      params: { token: "s3cret" },
    });

    await authenticate(test);
    expect(test.client.getStatus()).toBe("online");
    expect(test.ready).toBe(1);
    expect(test.statuses).toEqual(["connecting", "authenticating", "online"]);
  });

  it("skips the handshake entirely when no token is configured", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    expect(test.latest().sent).toHaveLength(0);
    expect(test.client.getStatus()).toBe("online");
    expect(test.ready).toBe(1);
  });

  it("stops for good when the server rejects the token", async () => {
    const test = harness({ token: "wrong" });
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    const frame = test.latest().last;
    test.latest().deliver({
      kind: "response",
      id: frame?.id,
      error: { code: "invalidRequest", message: "Invalid or missing token" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(test.client.getStatus()).toBe("unauthorized");
    // No retry is scheduled: a bad token retried forever is a lockout, not
    // resilience.
    await test.clock.advance(120_000);
    expect(test.sockets).toHaveLength(1);
  });

  it("treats a 4401 close as a rejected token, not a dropped connection", async () => {
    const test = harness({ token: "wrong" });
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    test.latest().drop(4401);
    await test.clock.advance(120_000);

    expect(test.client.getStatus()).toBe("unauthorized");
    expect(test.sockets).toHaveLength(1);
  });

  it("never repeats the token in any later frame", async () => {
    const test = harness({ token: "s3cret" });
    test.client.connect();
    await authenticate(test);
    void test.client.request("listSessions");
    void test.client.request("prompt", { sessionId: "s", text: "hello" }, { timeoutMs: 0 });
    await Promise.resolve();

    const frames = test.latest().sent;
    expect(frames).toHaveLength(3);
    for (const frame of frames.slice(1)) {
      expect(JSON.stringify(frame)).not.toContain("s3cret");
    }
  });
});

describe("web client transport: requests", () => {
  it("routes a response back to the request that asked for it", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();

    const first = test.client.request("listSessions");
    const second = test.client.request("openSession", { sessionId: "s2" });
    await Promise.resolve();
    const [frameA, frameB] = test.latest().sent;
    // Answered out of order on purpose: correlation is by id, not arrival.
    test.latest().deliver({ kind: "response", id: frameB?.id, result: { sessionId: "s2" } });
    test.latest().deliver({ kind: "response", id: frameA?.id, result: { sessions: [] } });

    await expect(second).resolves.toMatchObject({ sessionId: "s2" });
    await expect(first).resolves.toMatchObject({ sessions: [] });
  });

  it("rejects with the server's error code", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    const pending = test.client.request("prompt", { sessionId: "s", text: "x" });
    await Promise.resolve();
    test.latest().deliver({
      kind: "response",
      id: test.latest().last?.id,
      error: { code: "sessionBusy", message: "already running" },
    });
    await expect(pending).rejects.toMatchObject({ code: "sessionBusy" });
  });

  it("times out a request that is never answered, but honours timeoutMs: 0", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();

    const timed = test.client.request("listSessions", undefined, { timeoutMs: 1_000 });
    const untimed = test.client.request("prompt", { sessionId: "s", text: "x" }, { timeoutMs: 0 });
    let settled = false;
    void untimed.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await test.clock.advance(60_000);
    await expect(timed).rejects.toMatchObject({ code: "timeout" });
    // A prompt spans the whole remote run; a deadline on it would be a bug.
    expect(settled).toBe(false);
  });

  it("rejects every in-flight request when the socket drops", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    const pending = test.client.request("listSessions");
    await Promise.resolve();
    test.latest().drop();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
  });

  it("refuses to send while offline instead of throwing", async () => {
    const test = harness();
    await expect(test.client.request("listSessions")).rejects.toMatchObject({ code: "closed" });
  });

  it("ignores unroutable inbound traffic", async () => {
    const problems: string[] = [];
    const test = harness({ onProtocolError: (message) => problems.push(message) });
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    test.latest().onmessage?.({ data: "not json" });
    test.latest().deliver({ kind: "response", id: "nobody", result: 1 });
    test.latest().deliver({ kind: "unknown" });
    expect(problems).toHaveLength(1);
    expect(test.client.getStatus()).toBe("online");
  });

  it("forwards session events to the app", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    test.latest().deliver({
      kind: "event",
      sessionId: "s1",
      event: { type: "notice", level: "info", text: "hi" },
    });
    expect(test.events).toEqual([{ sessionId: "s1", type: "notice" }]);
  });
});

describe("web client transport: reconnect", () => {
  it("retries with exponential backoff and resubscribes on every reconnect", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    expect(test.ready).toBe(1);

    // Drop one: a 500ms retry is armed, and nothing reconnects before it.
    test.latest().drop();
    expect(test.clock.pending()).toEqual([500]);
    await test.clock.advance(499);
    expect(test.sockets).toHaveLength(1);
    await test.clock.advance(1);
    expect(test.sockets).toHaveLength(2);

    // Failing to open again doubles the delay, and again.
    test.latest().drop();
    expect(test.clock.pending()).toEqual([1_000]);
    await test.clock.advance(1_000);
    test.latest().drop();
    expect(test.clock.pending()).toEqual([2_000]);
    await test.clock.advance(2_000);
    expect(test.sockets).toHaveLength(4);

    // A successful open resubscribes and resets the schedule.
    test.latest().open();
    await Promise.resolve();
    expect(test.ready).toBe(2);
    expect(test.client.getAttempt()).toBe(0);
    test.latest().drop();
    expect(test.clock.pending()).toEqual([500]);
  });

  it("caps the delay so a long outage keeps retrying at a steady rate", () => {
    const delay = (attempt: number): number => model.backoffDelay(attempt, {}, () => 0.5);
    expect(delay(0)).toBe(500);
    expect(delay(1)).toBe(1_000);
    expect(delay(4)).toBe(8_000);
    expect(delay(20)).toBe(15_000);
    expect(delay(1_000)).toBe(15_000);
  });

  it("spreads retries with jitter so many clients do not stampede", () => {
    expect(model.backoffDelay(3, {}, () => 0)).toBe(3_000);
    expect(model.backoffDelay(3, {}, () => 1)).toBe(5_000);
  });

  it("reconnects immediately when the tab comes back, without waiting out the backoff", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    test.latest().drop();
    await test.clock.advance(500);
    test.latest().drop();
    expect(test.clock.pending()).toEqual([1_000]);

    // This is what visibilitychange calls when a phone is unlocked.
    test.client.retryNow();
    expect(test.sockets).toHaveLength(3);
    expect(test.clock.pending()).toEqual([]);
  });

  it("does not reconnect on retryNow once the token was rejected", async () => {
    const test = harness({ token: "wrong" });
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    test.latest().drop(4401);
    test.client.retryNow();
    expect(test.sockets).toHaveLength(1);
  });

  it("replaces a socket that stops answering the liveness probe", async () => {
    const test = harness({ probeIntervalMs: 10_000 });
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    expect(test.sockets).toHaveLength(1);

    // The probe is an ordinary listSessions; a phone that slept wakes with a
    // socket that looks open but answers nothing.
    await test.clock.advance(10_000);
    expect(test.latest().last).toMatchObject({ method: "listSessions" });
    await test.clock.advance(10_000);
    expect(test.sockets).toHaveLength(2);
  });

  it("keeps probing while the answers keep coming", async () => {
    const test = harness({ probeIntervalMs: 10_000 });
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    for (let round = 0; round < 3; round++) {
      await test.clock.advance(10_000);
      test.latest().deliver({ kind: "response", id: test.latest().last?.id, result: {} });
      await Promise.resolve();
    }
    expect(test.sockets).toHaveLength(1);
    expect(test.client.getStatus()).toBe("online");
  });

  it("stops retrying once the client is closed", async () => {
    const test = harness();
    test.client.connect();
    test.latest().open();
    await Promise.resolve();
    test.client.close();
    await test.clock.advance(60_000);
    expect(test.sockets).toHaveLength(1);
  });
});

describe("web client transport: token hygiene", () => {
  it("takes the token out of the URL and puts it nowhere else", () => {
    const replaced: string[] = [];
    const win = {
      location: { hash: "#token=abc123", search: "", pathname: "/" },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
    };
    expect(app.takeTokenFromLocation(win)).toBe("abc123");
    expect(replaced).toEqual(["/"]);
    expect(replaced.join("")).not.toContain("abc123");
  });

  it("does not accept a query-string token: fragment and prompt only", () => {
    const replaced: string[] = [];
    const win = {
      location: { hash: "", search: "?token=abc123&session=s1", pathname: "/" },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
    };
    expect(app.takeTokenFromLocation(win)).toBeNull();
    // A query-string token is sent to a server on every request (access
    // logs, proxies), so it is never even read — a browser that navigates
    // there still leaks it, but arcturn never treats it as valid input.
    expect(replaced).toEqual([]);
  });

  it("reports no token rather than an empty one", () => {
    const win = { location: { hash: "", search: "", pathname: "/" } };
    expect(app.takeTokenFromLocation(win)).toBeNull();
  });

  it("never writes the token to the console", () => {
    expect(APP_SCRIPT).not.toMatch(/console\./);
    expect(MODEL_SCRIPT).not.toMatch(/console\./);
  });
});

describe("web client transport: socket URL", () => {
  it("dials the host the page was loaded from, on the served WebSocket port", () => {
    const win = {
      location: { protocol: "http:", hostname: "192.168.1.5", search: "", port: "80" },
    };
    expect(app.resolveWsUrl(win, { wsPort: 7717 })).toBe("ws://192.168.1.5:7717");
  });

  it("upgrades to wss when the page itself was served over https", () => {
    const win = {
      location: { protocol: "https:", hostname: "arcturn.example", search: "", port: "" },
    };
    expect(app.resolveWsUrl(win, { wsPort: 7717 })).toBe("wss://arcturn.example:7717");
  });

  it("brackets a bare IPv6 host", () => {
    const win = { location: { protocol: "http:", hostname: "::1", search: "", port: "" } };
    expect(app.resolveWsUrl(win, { wsPort: 7717 })).toBe("ws://[::1]:7717");
  });

  it("lets an explicit ?ws= override win, for tunnels and proxies", () => {
    const win = {
      location: { protocol: "http:", hostname: "127.0.0.1", search: "?ws=ws%3A%2F%2Fbox%3A9000" },
    };
    expect(app.resolveWsUrl(win, { wsPort: 7717 })).toBe("ws://box:9000");
  });
});
