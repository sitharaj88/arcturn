import { describe, expect, it } from "vitest";
import {
  DEVICE_CODE_GRANT_TYPE,
  type DeviceAuthorization,
  type DeviceFlowConfig,
  pollDeviceToken,
  requestDeviceAuthorization,
} from "./device-flow.js";
import type { FetchLike, HttpRequestInit } from "./types.js";

const config: DeviceFlowConfig = {
  deviceAuthorizationEndpoint: "https://example.test/device/code",
  tokenEndpoint: "https://example.test/oauth/token",
  clientId: "client-1",
  scopes: ["read:user"],
  provider: "github-copilot",
};

const authorization: DeviceAuthorization = {
  deviceCode: "device-secret",
  userCode: "WDJB-MJHT",
  verificationUri: "https://example.test/activate",
  expiresIn: 900,
  interval: 5,
};

interface Call {
  url: string;
  params: URLSearchParams;
}

/** A fetch stub that replays scripted responses and records what was sent. */
function scriptedFetch(responses: Array<{ status?: number; body: unknown; form?: boolean }>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch: FetchLike = (url: string, init?: HttpRequestInit) => {
    calls.push({ url, params: new URLSearchParams(init?.body ?? "") });
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    if (!next) throw new Error("no scripted response");
    const text =
      next.form === true
        ? new URLSearchParams(next.body as Record<string, string>).toString()
        : JSON.stringify(next.body);
    return Promise.resolve({
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      text: () => Promise.resolve(text),
    });
  };
  return { fetch, calls };
}

/** A sleeper that records the delays instead of waiting for them. */
function recordingSleeper(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe("requestDeviceAuthorization", () => {
  it("returns the codes and the URL to display", async () => {
    const { fetch, calls } = scriptedFetch([
      {
        body: {
          device_code: "device-secret",
          user_code: "WDJB-MJHT",
          verification_uri: "https://example.test/activate",
          verification_uri_complete: "https://example.test/activate?code=WDJB-MJHT",
          expires_in: 1800,
          interval: 7,
        },
      },
    ]);

    const result = await requestDeviceAuthorization(config, { fetch });
    expect(result).toEqual({
      deviceCode: "device-secret",
      userCode: "WDJB-MJHT",
      verificationUri: "https://example.test/activate",
      verificationUriComplete: "https://example.test/activate?code=WDJB-MJHT",
      expiresIn: 1800,
      interval: 7,
    });
    expect(calls[0]?.url).toBe(config.deviceAuthorizationEndpoint);
    expect(calls[0]?.params.get("client_id")).toBe("client-1");
    expect(calls[0]?.params.get("scope")).toBe("read:user");
  });

  it("reads a form-encoded response and defaults the interval", async () => {
    const { fetch } = scriptedFetch([
      {
        form: true,
        body: {
          device_code: "d",
          user_code: "U-1",
          verification_uri: "https://example.test/a",
        },
      },
    ]);
    const result = await requestDeviceAuthorization(config, { fetch });
    expect(result.interval).toBe(5);
    expect(result.expiresIn).toBe(900);
    expect(result.verificationUriComplete).toBeUndefined();
  });

  it("surfaces a provider error", async () => {
    const { fetch } = scriptedFetch([
      { status: 400, body: { error: "unauthorized_client", error_description: "bad client" } },
    ]);
    await expect(requestDeviceAuthorization(config, { fetch })).rejects.toMatchObject({
      code: "unauthorized_client",
    });
  });

  it("rejects a response missing a mandatory field", async () => {
    const { fetch } = scriptedFetch([{ body: { device_code: "d", user_code: "U" } }]);
    await expect(requestDeviceAuthorization(config, { fetch })).rejects.toMatchObject({
      code: "arcturn_bad_response",
    });
  });
});

describe("pollDeviceToken", () => {
  it("polls through pending and slow_down, backing off five seconds each time", async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { error: "authorization_pending" } },
      { body: { error: "slow_down" } },
      { body: { error: "authorization_pending" } },
      { body: { access_token: "gho_token", token_type: "bearer", expires_in: 3600 } },
    ]);
    const { sleep, delays } = recordingSleeper();
    const attempts: number[] = [];

    const tokens = await pollDeviceToken(
      config,
      authorization,
      { fetch, sleep, now: () => 1_000_000 },
      { onPoll: (info) => attempts.push(info.intervalSeconds) },
    );

    expect(tokens.accessToken).toBe("gho_token");
    expect(tokens.tokenType).toBe("bearer");
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
    // 5s, 5s, then 10s after the slow_down, then 10s again.
    expect(delays).toEqual([5_000, 5_000, 10_000, 10_000]);
    expect(attempts).toEqual([5, 5, 10, 10]);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.params.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
    expect(calls[0]?.params.get("device_code")).toBe("device-secret");
  });

  it("waits one interval before the first poll", async () => {
    const { fetch } = scriptedFetch([{ body: { access_token: "t", token_type: "Bearer" } }]);
    const { sleep, delays } = recordingSleeper();
    await pollDeviceToken(config, authorization, { fetch, sleep, now: () => 0 });
    expect(delays).toEqual([5_000]);
  });

  it("fails on access_denied", async () => {
    const { fetch } = scriptedFetch([
      { status: 400, body: { error: "access_denied", error_description: "the user said no" } },
    ]);
    const { sleep } = recordingSleeper();
    await expect(
      pollDeviceToken(config, authorization, { fetch, sleep, now: () => 0 }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("fails on expired_token reported by the provider", async () => {
    const { fetch } = scriptedFetch([{ status: 400, body: { error: "expired_token" } }]);
    const { sleep } = recordingSleeper();
    await expect(
      pollDeviceToken(config, authorization, { fetch, sleep, now: () => 0 }),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  it("fails on any other OAuth error", async () => {
    const { fetch } = scriptedFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    const { sleep } = recordingSleeper();
    await expect(
      pollDeviceToken(config, authorization, { fetch, sleep, now: () => 0 }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("gives up once the device code's own lifetime elapses", async () => {
    const { fetch } = scriptedFetch([{ body: { error: "authorization_pending" } }]);
    let clock = 0;
    const sleep = (ms: number): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    };
    await expect(
      pollDeviceToken(
        config,
        { ...authorization, expiresIn: 12 },
        { fetch, sleep, now: () => clock },
      ),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch } = scriptedFetch([{ body: { error: "authorization_pending" } }]);
    const { sleep } = recordingSleeper();
    await expect(
      pollDeviceToken(config, authorization, {
        fetch,
        sleep,
        now: () => 0,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "arcturn_cancelled" });
  });

  it("honours the attempt cap", async () => {
    const { fetch, calls } = scriptedFetch([{ body: { error: "authorization_pending" } }]);
    const { sleep } = recordingSleeper();
    await expect(
      pollDeviceToken(config, authorization, { fetch, sleep, now: () => 0 }, { maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "expired_token" });
    expect(calls).toHaveLength(3);
  });

  it("never puts the device code into an error message", async () => {
    const { fetch } = scriptedFetch([
      {
        status: 400,
        body: { error: "invalid_grant", error_description: "device_code=device-secret is bad" },
      },
    ]);
    const { sleep } = recordingSleeper();
    const error = await pollDeviceToken(config, authorization, {
      fetch,
      sleep,
      now: () => 0,
    }).catch((err: unknown) => err as Error);
    expect(error.message).not.toContain("device-secret");
    expect(error.message).toContain("[redacted]");
  });
});
