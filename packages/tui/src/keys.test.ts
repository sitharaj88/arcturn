import { describe, expect, it } from "vitest";
import { createKey, isPrintable, type Key, KeyDecoder, keyToString, matchesKey } from "./keys.js";

const ESC = "\u001b";

function decode(...chunks: string[]): Key[] {
  const decoder = new KeyDecoder();
  const keys: Key[] = [];
  for (const chunk of chunks) keys.push(...decoder.push(chunk));
  keys.push(...decoder.flush());
  return keys;
}

function names(keys: Key[]): string[] {
  return keys.map(keyToString);
}

describe("printable characters", () => {
  it("decodes ASCII letters and symbols", () => {
    expect(names(decode("a"))).toEqual(["a"]);
    expect(names(decode("$"))).toEqual(["$"]);
    expect(decode("a")[0]?.text).toBe("a");
  });

  it("marks uppercase letters as shifted", () => {
    const key = decode("A")[0];
    expect(key?.name).toBe("A");
    expect(key?.shift).toBe(true);
  });

  it("decodes a run of characters into separate events", () => {
    expect(names(decode("abc"))).toEqual(["a", "b", "c"]);
  });

  it("keeps multi-code-unit graphemes intact", () => {
    expect(names(decode("日"))).toEqual(["日"]);
    expect(names(decode("👍"))).toEqual(["👍"]);
    expect(decode("é")[0]?.text).toBe("é");
  });

  it("reports printability", () => {
    expect(isPrintable(decode("a")[0]!)).toBe(true);
    expect(isPrintable(decode("\r")[0]!)).toBe(false);
  });
});

describe("control keys", () => {
  it("decodes enter, tab and backspace", () => {
    expect(names(decode("\r"))).toEqual(["enter"]);
    expect(names(decode("\n"))).toEqual(["enter"]);
    expect(names(decode("\t"))).toEqual(["tab"]);
    expect(names(decode("\u007f"))).toEqual(["backspace"]);
  });

  it("decodes ctrl+letter from the control byte", () => {
    expect(names(decode("\u0003"))).toEqual(["ctrl+c"]);
    expect(names(decode("\u0001"))).toEqual(["ctrl+a"]);
    expect(names(decode("\u000b"))).toEqual(["ctrl+k"]);
  });

  it("decodes ctrl+space and ctrl+symbols", () => {
    expect(names(decode("\u0000"))).toEqual(["ctrl+space"]);
    expect(names(decode("\u001f"))).toEqual(["ctrl+_"]);
  });

  it("decodes alt+letter from the ESC prefix", () => {
    expect(names(decode(`${ESC}b`))).toEqual(["alt+b"]);
    expect(names(decode(`${ESC}f`))).toEqual(["alt+f"]);
  });

  it("decodes alt+enter", () => {
    expect(names(decode(`${ESC}\r`))).toEqual(["alt+enter"]);
  });

  it("resolves a lone ESC into escape on flush", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(ESC)).toEqual([]);
    expect(decoder.pending).toBe(ESC);
    expect(names(decoder.flush())).toEqual(["escape"]);
  });
});

describe("escape sequences", () => {
  it("decodes arrow keys in CSI and SS3 form", () => {
    expect(names(decode(`${ESC}[A`, `${ESC}[B`, `${ESC}[C`, `${ESC}[D`))).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
    expect(names(decode(`${ESC}OA`))).toEqual(["up"]);
  });

  it("decodes navigation keys", () => {
    expect(names(decode(`${ESC}[H`))).toEqual(["home"]);
    expect(names(decode(`${ESC}[F`))).toEqual(["end"]);
    expect(names(decode(`${ESC}[1~`))).toEqual(["home"]);
    expect(names(decode(`${ESC}[4~`))).toEqual(["end"]);
    expect(names(decode(`${ESC}[5~`))).toEqual(["pageup"]);
    expect(names(decode(`${ESC}[6~`))).toEqual(["pagedown"]);
    expect(names(decode(`${ESC}[2~`))).toEqual(["insert"]);
    expect(names(decode(`${ESC}[3~`))).toEqual(["delete"]);
  });

  it("decodes shift+tab", () => {
    expect(names(decode(`${ESC}[Z`))).toEqual(["shift+tab"]);
  });

  it("decodes function keys", () => {
    expect(names(decode(`${ESC}OP`))).toEqual(["f1"]);
    expect(names(decode(`${ESC}[15~`))).toEqual(["f5"]);
    expect(names(decode(`${ESC}[24~`))).toEqual(["f12"]);
  });

  it("decodes xterm modifier parameters", () => {
    expect(names(decode(`${ESC}[1;5C`))).toEqual(["ctrl+right"]);
    expect(names(decode(`${ESC}[1;3D`))).toEqual(["alt+left"]);
    expect(names(decode(`${ESC}[1;2A`))).toEqual(["shift+up"]);
    expect(names(decode(`${ESC}[1;6B`))).toEqual(["ctrl+shift+down"]);
    expect(names(decode(`${ESC}[3;5~`))).toEqual(["ctrl+delete"]);
  });

  it("decodes Kitty CSI-u sequences", () => {
    expect(names(decode(`${ESC}[97;5u`))).toEqual(["ctrl+a"]);
    expect(names(decode(`${ESC}[13;2u`))).toEqual(["shift+enter"]);
    expect(names(decode(`${ESC}[27u`))).toEqual(["escape"]);
  });

  it("decodes xterm modifyOtherKeys sequences", () => {
    expect(names(decode(`${ESC}[27;5;97~`))).toEqual(["ctrl+a"]);
  });

  it("swallows SGR mouse reports without emitting a key", () => {
    expect(decode(`${ESC}[<0;10;5M`)).toEqual([]);
  });
});

describe("SGR mouse reports", () => {
  it("decodes wheel up and wheel down as synthetic keys", () => {
    expect(names(decode(`${ESC}[<64;10;5M`))).toEqual(["wheelup"]);
    expect(names(decode(`${ESC}[<65;10;5M`))).toEqual(["wheeldown"]);
  });

  it("emits wheel keys with no modifiers", () => {
    const key = decode(`${ESC}[<64;1;1M`)[0]!;
    expect(key.ctrl).toBe(false);
    expect(key.alt).toBe(false);
    expect(key.shift).toBe(false);
    expect(key.meta).toBe(false);
    expect(key.text).toBeUndefined();
    expect(matchesKey(key, "wheelup")).toBe(true);
    expect(matchesKey(decode(`${ESC}[<65;1;1M`)[0]!, "wheeldown")).toBe(true);
  });

  it("matches wheel codes with modifier bits set", () => {
    expect(names(decode(`${ESC}[<68;10;5M`))).toEqual(["wheelup"]); // shift
    expect(names(decode(`${ESC}[<72;10;5M`))).toEqual(["wheelup"]); // meta
    expect(names(decode(`${ESC}[<80;10;5M`))).toEqual(["wheelup"]); // ctrl
    expect(names(decode(`${ESC}[<92;10;5M`))).toEqual(["wheelup"]); // all three
    expect(names(decode(`${ESC}[<69;10;5M`))).toEqual(["wheeldown"]); // shift
    expect(names(decode(`${ESC}[<81;10;5M`))).toEqual(["wheeldown"]); // ctrl
  });

  it("swallows click press and release without emitting keys", () => {
    expect(decode(`${ESC}[<0;10;5M${ESC}[<0;10;5m`)).toEqual([]);
    expect(decode(`${ESC}[<2;40;12M${ESC}[<2;40;12m`)).toEqual([]);
  });

  it("swallows drag motion and wheel release variants", () => {
    expect(decode(`${ESC}[<32;12;6M`)).toEqual([]);
    expect(decode(`${ESC}[<35;12;6M`)).toEqual([]);
    expect(decode(`${ESC}[<64;12;6m`)).toEqual([]);
  });

  it("does not treat wheel-left or wheel-right as vertical wheel keys", () => {
    expect(decode(`${ESC}[<66;10;5M`)).toEqual([]);
    expect(decode(`${ESC}[<67;10;5M`)).toEqual([]);
  });

  it("buffers a mouse sequence split across chunks", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(`${ESC}[<64;10`)).toEqual([]);
    expect(decoder.pending).toBe(`${ESC}[<64;10`);
    expect(names(decoder.push(";5M"))).toEqual(["wheelup"]);
    expect(decoder.pending).toBe("");
  });

  it("buffers a mouse sequence split byte by byte", () => {
    const decoder = new KeyDecoder();
    const keys: Key[] = [];
    for (const ch of `${ESC}[<65;3;4M`) keys.push(...decoder.push(ch));
    expect(names(keys)).toEqual(["wheeldown"]);
  });

  it("drops an incomplete mouse sequence on flush without garbage keys", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(`${ESC}[<64;10`)).toEqual([]);
    expect(decoder.flush()).toEqual([]);
    expect(decoder.pending).toBe("");
  });

  it("interleaves wheel events with ordinary keys in one chunk", () => {
    expect(names(decode(`a${ESC}[<64;3;4Mb`))).toEqual(["a", "wheelup", "b"]);
    expect(names(decode(`${ESC}[<0;1;1Mx${ESC}[<65;1;1M${ESC}[A`))).toEqual([
      "x",
      "wheeldown",
      "up",
    ]);
  });
});

describe("chunked input", () => {
  it("buffers a CSI sequence split across chunks", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(ESC)).toEqual([]);
    expect(decoder.push("[")).toEqual([]);
    expect(names(decoder.push("A"))).toEqual(["up"]);
    expect(decoder.pending).toBe("");
  });

  it("buffers a sequence split byte by byte", () => {
    const decoder = new KeyDecoder();
    const seq = `${ESC}[1;5C`;
    const keys: Key[] = [];
    for (const ch of seq) keys.push(...decoder.push(ch));
    expect(names(keys)).toEqual(["ctrl+right"]);
  });

  it("emits leading text before an incomplete trailing sequence", () => {
    const decoder = new KeyDecoder();
    expect(names(decoder.push(`ab${ESC}[`))).toEqual(["a", "b"]);
    expect(names(decoder.push("D"))).toEqual(["left"]);
  });

  it("handles several sequences arriving in one chunk", () => {
    expect(names(decode(`${ESC}[A${ESC}[Bx`))).toEqual(["up", "down", "x"]);
  });

  it("does not mistake ESC ESC [ for alt+escape", () => {
    expect(names(decode(`${ESC}${ESC}[A`))).toEqual(["escape", "up"]);
  });
});

describe("bracketed paste", () => {
  it("emits one paste event with the full content", () => {
    const keys = decode(`${ESC}[200~hello world${ESC}[201~`);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.name).toBe("paste");
    expect(keys[0]?.paste).toBe("hello world");
  });

  it("keeps embedded newlines and escape-looking bytes verbatim", () => {
    const payload = "line1\nline2\tX";
    const keys = decode(`${ESC}[200~${payload}${ESC}[201~`);
    expect(keys[0]?.paste).toBe(payload);
  });

  it("buffers a paste that arrives in pieces", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(`${ESC}[200~he`)).toEqual([]);
    expect(decoder.push("llo")).toEqual([]);
    const keys = decoder.push(`${ESC}[201~`);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.paste).toBe("hello");
  });

  it("buffers a paste whose start marker is split", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(`${ESC}[20`)).toEqual([]);
    expect(decoder.push("0~hi")).toEqual([]);
    expect(decoder.push(`${ESC}[201~`)[0]?.paste).toBe("hi");
  });

  it("continues decoding keys typed after the paste", () => {
    const keys = decode(`${ESC}[200~hi${ESC}[201~\r`);
    expect(names(keys)).toEqual(["paste", "enter"]);
  });
});

describe("matchesKey", () => {
  it("matches modifier combinations in any order", () => {
    const key = createKey("a", { ctrl: true, shift: true });
    expect(matchesKey(key, "ctrl+shift+a")).toBe(true);
    expect(matchesKey(key, "shift+ctrl+a")).toBe(true);
    expect(matchesKey(key, "ctrl+a")).toBe(false);
  });

  it("accepts modifier aliases", () => {
    const key = createKey("x", { meta: true });
    expect(matchesKey(key, "cmd+x")).toBe(true);
    expect(matchesKey(key, "super+x")).toBe(true);
  });

  it("matches special key names", () => {
    expect(matchesKey(decode(`${ESC}[Z`)[0]!, "shift+tab")).toBe(true);
    expect(matchesKey(decode("\u0003")[0]!, "ctrl+c")).toBe(true);
  });
});
