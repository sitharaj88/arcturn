import { describe, expect, it, vi } from "vitest";
import { connectToServe } from "./connect.js";
import { FakeSocket } from "./test-socket.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("connectToServe", () => {
  it("opens the socket against a url with no fragment on it", async () => {
    const opened: string[] = [];
    const socket = new FakeSocket();
    await connectToServe({
      connectUrl: `ws://127.0.0.1:1/#token=${TOKEN}`,
      socketFactory: (url) => {
        opened.push(url);
        return socket;
      },
    });
    expect(opened).toEqual(["ws://127.0.0.1:1/"]);
  });

  it("authenticates with the token from the fragment as the very first frame", async () => {
    const socket = new FakeSocket();
    await connectToServe({
      connectUrl: `ws://127.0.0.1:1#token=${TOKEN}`,
      socketFactory: () => socket,
    });
    const first = socket.frame(0);
    expect(first.method).toBe("authenticate");
    expect(first.params?.token).toBe(TOKEN);
  });

  it("arms no request deadline, because prompt() resolves at the end of the run", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const client = await connectToServe({
        connectUrl: "ws://127.0.0.1:1",
        socketFactory: () => socket,
      });
      let settled = false;
      const mark = (): void => {
        settled = true;
      };
      // `SessionHost.prompt` awaits the agent, so an eight-minute run answers
      // this frame eight minutes from now. A 30s default deadline would reject
      // a prompt that is still running perfectly well.
      client.prompt("s", "hi").then(mark, mark);
      await vi.advanceTimersByTimeAsync(480_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to connect to a non-loopback address", async () => {
    await expect(
      connectToServe({
        connectUrl: `ws://10.0.0.9:1#token=${TOKEN}`,
        socketFactory: () => new FakeSocket(),
      }),
    ).rejects.toThrow(/loopback/i);
  });

  it("never puts the token in a protocol-error diagnostic", async () => {
    const socket = new FakeSocket();
    const logged: string[] = [];
    await connectToServe({
      connectUrl: `ws://127.0.0.1:1#token=${TOKEN}`,
      socketFactory: () => socket,
      onDiagnostic: (line) => logged.push(line),
    });
    socket.emit("not json at all");
    socket.emit({ kind: "response", id: `bogus-${TOKEN}` });
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});
