import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  backgroundHexOf,
  parseOsc11Reply,
  queryTerminalBackground,
  setBackgroundSequence,
} from "./osc.js";

const ESC = "\u001b";
const BEL = "\u0007";

describe("parseOsc11Reply", () => {
  it("extracts a BEL-terminated colour spec", () => {
    expect(parseOsc11Reply(`${ESC}]11;rgb:fafa/f6f6/efef${BEL}`)).toBe("rgb:fafa/f6f6/efef");
  });

  it("extracts an ST-terminated colour spec", () => {
    expect(parseOsc11Reply(`${ESC}]11;rgb:0000/2b2b/3636${ESC}\\`)).toBe("rgb:0000/2b2b/3636");
  });

  it("waits for the terminator on a split reply", () => {
    expect(parseOsc11Reply(`${ESC}]11;rgb:fafa/f6`)).toBeUndefined();
  });

  it("ignores an echoed query and junk", () => {
    expect(parseOsc11Reply(`${ESC}]11;?${BEL}`)).toBeUndefined();
    expect(parseOsc11Reply("")).toBeUndefined();
    expect(parseOsc11Reply(`${ESC}[?62;c`)).toBeUndefined();
  });
});

describe("backgroundHexOf / setBackgroundSequence", () => {
  it("converts a truecolour SGR open to hex", () => {
    expect(backgroundHexOf(`${ESC}[48;2;250;246;239m`)).toBe("#faf6ef");
    expect(backgroundHexOf(`${ESC}[48;2;12;10;7m`)).toBe("#0c0a07");
  });

  it("returns undefined without a truecolour background", () => {
    expect(backgroundHexOf("")).toBeUndefined();
    expect(backgroundHexOf(`${ESC}[48;5;230m`)).toBeUndefined();
  });

  it("builds the set sequence", () => {
    expect(setBackgroundSequence("#faf6ef")).toBe(`${ESC}]11;#faf6ef${BEL}`);
    expect(setBackgroundSequence("rgb:00/2b/36")).toBe(`${ESC}]11;rgb:00/2b/36${BEL}`);
  });
});

class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  raw: boolean[] = [];
  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.raw.push(value);
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

function fakeIo(onWrite: (tty: FakeTty) => void) {
  const input = new FakeTty();
  const output = {
    isTTY: true,
    write: (_d: string): boolean => {
      queueMicrotask(() => onWrite(input));
      return true;
    },
  };
  return {
    io: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    input,
  };
}

describe("queryTerminalBackground", () => {
  it("resolves the raw spec and restores raw mode", async () => {
    const { io, input } = fakeIo((tty) => tty.emit("data", `${ESC}]11;rgb:fafa/f6f6/efef${BEL}`));
    await expect(queryTerminalBackground({ io, timeoutMs: 500 })).resolves.toBe(
      "rgb:fafa/f6f6/efef",
    );
    expect(input.raw).toEqual([true, false]);
  });

  it("assembles a reply split across reads", async () => {
    const { io } = fakeIo((tty) => {
      tty.emit("data", `${ESC}]11;rgb:00`);
      tty.emit("data", `00/2b2b/3636${BEL}`);
    });
    await expect(queryTerminalBackground({ io, timeoutMs: 500 })).resolves.toBe(
      "rgb:0000/2b2b/3636",
    );
  });

  it("gives up early when only the DA1 reply arrives", async () => {
    const { io } = fakeIo((tty) => tty.emit("data", `${ESC}[?62;c`));
    await expect(queryTerminalBackground({ io, timeoutMs: 5_000 })).resolves.toBeUndefined();
  });

  it("times out to undefined on a silent terminal", async () => {
    const { io } = fakeIo(() => {});
    await expect(queryTerminalBackground({ io, timeoutMs: 20 })).resolves.toBeUndefined();
  });

  it("skips the query entirely off a TTY", async () => {
    const { io } = fakeIo(() => {
      throw new Error("must not write");
    });
    (io.input as unknown as { isTTY: boolean }).isTTY = false;
    await expect(queryTerminalBackground({ io })).resolves.toBeUndefined();
  });
});
