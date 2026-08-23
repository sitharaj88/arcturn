import { beforeEach, describe, expect, it } from "vitest";
import { ColorLevel, setColorLevel, stripAnsi } from "../ansi.js";
import { createKey, type Key, KeyDecoder } from "../keys.js";
import {
  type AutocompleteProvider,
  type AutocompleteSuggestion,
  Editor,
  wordBoundaryBackward,
  wordBoundaryForward,
} from "./editor.js";

const ESC = "\u001b";

beforeEach(() => {
  setColorLevel(ColorLevel.None);
});

/** Types a run of printable characters, one key event per character. */
function type(editor: Editor, text: string): void {
  for (const ch of text) editor.handleInput(createKey(ch, { text: ch }));
}

function press(editor: Editor, name: string, mods: Record<string, boolean> = {}): boolean {
  return editor.handleInput(createKey(name, mods));
}

function pasteKey(content: string): Key {
  const keys = new KeyDecoder().push(`${ESC}[200~${content}${ESC}[201~`);
  return keys[0]!;
}

describe("typing", () => {
  it("inserts printable characters at the caret", () => {
    const editor = new Editor();
    type(editor, "hello");
    expect(editor.text).toBe("hello");
    expect(editor.state.cursorCol).toBe(5);
  });

  it("inserts wide characters and emoji as single graphemes", () => {
    const editor = new Editor();
    type(editor, "日本");
    editor.handleInput(createKey("👍", { text: "👍" }));
    expect(editor.text).toBe("日本👍");
  });

  it("reports changes through onChange", () => {
    const seen: string[] = [];
    const editor = new Editor({ onChange: (text) => seen.push(text) });
    type(editor, "ab");
    expect(seen).toEqual(["a", "ab"]);
  });

  it("inserts a newline for shift+enter and alt+enter but not plain enter", () => {
    const editor = new Editor();
    type(editor, "a");
    press(editor, "enter", { shift: true });
    type(editor, "b");
    press(editor, "enter", { alt: true });
    type(editor, "c");
    expect(editor.text).toBe("a\nb\nc");
  });

  it("inserts a newline for ctrl+j", () => {
    const editor = new Editor();
    type(editor, "a");
    press(editor, "j", { ctrl: true });
    expect(editor.text).toBe("a\n");
  });
});

describe("cursor movement", () => {
  it("moves by character across line boundaries", () => {
    const editor = new Editor({ initialText: "ab\ncd" });
    expect(editor.state).toMatchObject({ cursorLine: 1, cursorCol: 2 });
    press(editor, "home");
    expect(editor.state).toMatchObject({ cursorLine: 1, cursorCol: 0 });
    press(editor, "left");
    expect(editor.state).toMatchObject({ cursorLine: 0, cursorCol: 2 });
    press(editor, "right");
    expect(editor.state).toMatchObject({ cursorLine: 1, cursorCol: 0 });
  });

  it("moves by whole graphemes, not code units", () => {
    const editor = new Editor({ initialText: "a👍b" });
    press(editor, "home");
    press(editor, "right");
    press(editor, "right");
    expect(editor.state.cursorCol).toBe(3); // "a" + surrogate pair
  });

  it("moves by word with alt+arrow and emacs bindings", () => {
    const editor = new Editor({ initialText: "alpha beta gamma" });
    press(editor, "left", { alt: true });
    expect(editor.state.cursorCol).toBe(11);
    press(editor, "b", { alt: true });
    expect(editor.state.cursorCol).toBe(6);
    press(editor, "f", { alt: true });
    expect(editor.state.cursorCol).toBe(10);
  });

  it("supports ctrl+a and ctrl+e for line start and end", () => {
    const editor = new Editor({ initialText: "hello" });
    press(editor, "a", { ctrl: true });
    expect(editor.state.cursorCol).toBe(0);
    press(editor, "e", { ctrl: true });
    expect(editor.state.cursorCol).toBe(5);
  });

  it("moves vertically between lines", () => {
    const editor = new Editor({ initialText: "line one\nline two" });
    press(editor, "up");
    expect(editor.state.cursorLine).toBe(0);
    press(editor, "down");
    expect(editor.state.cursorLine).toBe(1);
  });
});

describe("deletion", () => {
  it("deletes backwards, joining lines at column 0", () => {
    const editor = new Editor({ initialText: "ab\ncd" });
    press(editor, "home");
    press(editor, "backspace");
    expect(editor.text).toBe("abcd");
    expect(editor.state.cursorCol).toBe(2);
  });

  it("deletes forwards with delete and ctrl+d", () => {
    const editor = new Editor({ initialText: "abc" });
    press(editor, "home");
    press(editor, "delete");
    expect(editor.text).toBe("bc");
    press(editor, "d", { ctrl: true });
    expect(editor.text).toBe("c");
  });

  it("deletes a whole grapheme, not half a surrogate pair", () => {
    const editor = new Editor({ initialText: "a👍" });
    press(editor, "backspace");
    expect(editor.text).toBe("a");
  });

  it("deletes the previous word with ctrl+w", () => {
    const editor = new Editor({ initialText: "alpha beta" });
    press(editor, "w", { ctrl: true });
    expect(editor.text).toBe("alpha ");
    expect(editor.killed).toBe("beta");
  });

  it("deletes the next word with alt+d", () => {
    const editor = new Editor({ initialText: "alpha beta" });
    press(editor, "home");
    press(editor, "d", { alt: true });
    expect(editor.text).toBe(" beta");
  });
});

describe("kill and yank", () => {
  it("kills to end of line with ctrl+k and yanks it back", () => {
    const editor = new Editor({ initialText: "hello world" });
    press(editor, "home");
    press(editor, "right");
    press(editor, "right");
    press(editor, "right");
    press(editor, "right");
    press(editor, "right");
    press(editor, "k", { ctrl: true });
    expect(editor.text).toBe("hello");
    expect(editor.killed).toBe(" world");
    press(editor, "y", { ctrl: true });
    expect(editor.text).toBe("hello world");
  });

  it("kills to line start with ctrl+u", () => {
    const editor = new Editor({ initialText: "hello world" });
    press(editor, "u", { ctrl: true });
    expect(editor.text).toBe("");
    expect(editor.killed).toBe("hello world");
  });
});

describe("undo", () => {
  it("coalesces a run of word characters into one checkpoint", () => {
    const editor = new Editor();
    type(editor, "abc");
    expect(editor.undoDepth).toBe(1);
    editor.undo();
    expect(editor.text).toBe("");
  });

  it("starts a new checkpoint at whitespace", () => {
    const editor = new Editor();
    type(editor, "ab cd");
    editor.undo();
    expect(editor.text).toBe("ab");
  });

  it("restores the caret along with the text", () => {
    const editor = new Editor({ initialText: "hello" });
    press(editor, "home");
    press(editor, "k", { ctrl: true });
    expect(editor.text).toBe("");
    editor.undo();
    expect(editor.text).toBe("hello");
    expect(editor.state.cursorCol).toBe(0);
  });

  it("is reachable through ctrl+z", () => {
    const editor = new Editor();
    type(editor, "abc");
    press(editor, "z", { ctrl: true });
    expect(editor.text).toBe("");
  });

  it("returns false when there is nothing to undo", () => {
    expect(new Editor().undo()).toBe(false);
  });
});

describe("submit", () => {
  it("emits the trimmed text, records history and clears the buffer", () => {
    const submitted: string[] = [];
    const editor = new Editor({ onSubmit: (text) => submitted.push(text) });
    type(editor, "hello");
    press(editor, "enter");
    expect(submitted).toEqual(["hello"]);
    expect(editor.text).toBe("");
    expect(editor.history).toEqual(["hello"]);
  });

  it("ignores an empty submission", () => {
    const submitted: string[] = [];
    const editor = new Editor({ onSubmit: (text) => submitted.push(text) });
    press(editor, "enter");
    expect(submitted).toEqual([]);
    expect(editor.history).toEqual([]);
  });

  it("does not record consecutive duplicates", () => {
    const editor = new Editor();
    type(editor, "same");
    press(editor, "enter");
    type(editor, "same");
    press(editor, "enter");
    expect(editor.history).toEqual(["same"]);
  });
});

describe("history navigation", () => {
  it("walks backwards through past submissions with up", () => {
    const editor = new Editor({ history: ["first", "second"] });
    press(editor, "up");
    expect(editor.text).toBe("second");
    press(editor, "up");
    expect(editor.text).toBe("first");
  });

  it("stops at the oldest entry", () => {
    const editor = new Editor({ history: ["only"] });
    press(editor, "up");
    press(editor, "up");
    expect(editor.text).toBe("only");
  });

  it("walks forwards again and restores the draft", () => {
    const editor = new Editor({ history: ["first", "second"] });
    type(editor, "draft");
    press(editor, "up");
    expect(editor.text).toBe("second");
    press(editor, "down");
    expect(editor.text).toBe("draft");
  });

  it("only enters history from the first line", () => {
    const editor = new Editor({ history: ["past"], initialText: "a\nb" });
    press(editor, "up");
    expect(editor.text).toBe("a\nb");
    press(editor, "up");
    expect(editor.text).toBe("past");
  });

  it("caps the history length", () => {
    const editor = new Editor({ maxHistory: 2 });
    for (const word of ["one", "two", "three"]) {
      type(editor, word);
      press(editor, "enter");
    }
    expect(editor.history).toEqual(["two", "three"]);
  });
});

describe("bracketed paste", () => {
  it("inserts the whole payload, including newlines", () => {
    const editor = new Editor();
    editor.handleInput(pasteKey("foo\nbar"));
    expect(editor.text).toBe("foo\nbar");
    expect(editor.state).toMatchObject({ cursorLine: 1, cursorCol: 3 });
  });

  it("is a single undo unit", () => {
    const editor = new Editor();
    type(editor, "x");
    editor.handleInput(pasteKey("aaa bbb ccc"));
    expect(editor.text).toBe("xaaa bbb ccc");
    editor.undo();
    expect(editor.text).toBe("x");
  });

  it("normalises CRLF and tabs", () => {
    const editor = new Editor();
    editor.handleInput(pasteKey("a\r\n\tb"));
    expect(editor.text).toBe("a\n    b");
  });

  it("splices into existing text at the caret", () => {
    const editor = new Editor({ initialText: "ac" });
    press(editor, "left");
    editor.handleInput(pasteKey("b"));
    expect(editor.text).toBe("abc");
  });

  it("strips an OSC 52 clipboard-write sequence from pasted content", () => {
    const editor = new Editor();
    const BEL = "\x07";
    editor.handleInput(pasteKey(`before${ESC}]52;c;${btoa("owned")}${BEL}after`));
    expect(editor.text).toBe("beforeafter");
  });

  it("strips a bare CSI sequence from pasted content", () => {
    const editor = new Editor();
    editor.handleInput(pasteKey(`red${ESC}[31mtext${ESC}[0m`));
    expect(editor.text).toBe("redtext");
  });

  it("strips a lone ESC byte with no following sequence", () => {
    const editor = new Editor();
    editor.handleInput(pasteKey(`a${ESC}b`));
    expect(editor.text).toBe("ab");
  });

  it("strips a bare BEL byte", () => {
    const editor = new Editor();
    const BEL = "\x07";
    editor.handleInput(pasteKey(`a${BEL}b`));
    expect(editor.text).toBe("ab");
  });

  it("leaves multi-byte unicode and emoji intact", () => {
    const editor = new Editor();
    editor.handleInput(pasteKey("héllo 世界 🎉👍🏽"));
    expect(editor.text).toBe("héllo 世界 🎉👍🏽");
  });
});

describe("untrusted text sanitisation", () => {
  it("strips control bytes from the constructor's initialText", () => {
    const editor = new Editor({ initialText: `hi${ESC}[31mred` });
    expect(editor.text).toBe("hired");
  });

  it("strips control bytes passed to setText", () => {
    const editor = new Editor();
    const BEL = "\x07";
    editor.setText(`x${ESC}]52;c;abcd${BEL}y`);
    expect(editor.text).toBe("xy");
  });
});

describe("autocomplete", () => {
  const provider: AutocompleteProvider = {
    getSuggestions({ prefix }) {
      const all: AutocompleteSuggestion[] = [
        { value: "@alpha", description: "first" },
        { value: "@beta", description: "second" },
      ];
      return all.filter((s) => s.value.startsWith(prefix));
    },
  };

  it("opens the dropdown when a trigger character is typed", () => {
    const editor = new Editor({ autocomplete: provider });
    type(editor, "@");
    expect(editor.isAutocompleteOpen).toBe(true);
    expect(editor.suggestions.map((s) => s.value)).toEqual(["@alpha", "@beta"]);
  });

  it("narrows the suggestions as more is typed", () => {
    const editor = new Editor({ autocomplete: provider });
    type(editor, "@b");
    expect(editor.suggestions.map((s) => s.value)).toEqual(["@beta"]);
  });

  it("closes when nothing matches", () => {
    const editor = new Editor({ autocomplete: provider });
    type(editor, "@zzz");
    expect(editor.isAutocompleteOpen).toBe(false);
  });

  it("accepts the highlighted suggestion with tab", () => {
    const editor = new Editor({ autocomplete: provider });
    type(editor, "@");
    press(editor, "tab");
    expect(editor.text).toBe("@alpha");
    expect(editor.isAutocompleteOpen).toBe(false);
  });

  it("accepts with enter instead of submitting", () => {
    const submitted: string[] = [];
    const editor = new Editor({ autocomplete: provider, onSubmit: (t) => submitted.push(t) });
    type(editor, "@");
    press(editor, "enter");
    expect(editor.text).toBe("@alpha");
    expect(submitted).toEqual([]);
  });

  it("navigates the dropdown with the arrow keys", () => {
    const editor = new Editor({ autocomplete: provider });
    type(editor, "@");
    press(editor, "down");
    press(editor, "tab");
    expect(editor.text).toBe("@beta");
  });

  it("closes on escape without invoking onCancel", () => {
    let cancelled = 0;
    const editor = new Editor({ autocomplete: provider, onCancel: () => cancelled++ });
    type(editor, "@");
    press(editor, "escape");
    expect(editor.isAutocompleteOpen).toBe(false);
    expect(cancelled).toBe(0);
    press(editor, "escape");
    expect(cancelled).toBe(1);
  });

  it("honours a custom applyCompletion", () => {
    const editor = new Editor({
      autocomplete: {
        getSuggestions: () => [{ value: "expanded" }],
        applyCompletion: () => ({ lines: ["replaced"], cursorLine: 0, cursorCol: 8 }),
      },
    });
    type(editor, "@");
    press(editor, "tab");
    expect(editor.text).toBe("replaced");
  });

  it("resolves asynchronous providers", async () => {
    const editor = new Editor({
      autocomplete: {
        getSuggestions: async () => [{ value: "@later" }],
      },
    });
    type(editor, "@");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.suggestions.map((s) => s.value)).toEqual(["@later"]);
  });
});

describe("rendering", () => {
  it("draws the prompt and the buffer", () => {
    const editor = new Editor({ prompt: "> ", initialText: "hi" });
    expect(editor.render(20).map(stripAnsi)).toEqual(["> hi"]);
  });

  it("shows the placeholder while empty", () => {
    const editor = new Editor({ prompt: "> ", placeholder: "type here" });
    expect(editor.render(20).map(stripAnsi)).toEqual(["> type here"]);
  });

  it("indents continuation lines under the prompt", () => {
    const editor = new Editor({ prompt: ">> ", initialText: "a\nb" });
    expect(editor.render(20).map(stripAnsi)).toEqual([">> a", "   b"]);
  });

  it("soft-wraps long lines within the available width", () => {
    const editor = new Editor({ prompt: "> ", initialText: "aaaa bbbb cccc" });
    const lines = editor.render(9).map(stripAnsi);
    // The break whitespace stays in the buffer so the caret can still sit on it.
    expect(lines).toEqual(["> aaaa ", "  bbbb ", "  cccc"]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(9);
  });

  it("reports the cursor position after rendering", () => {
    const editor = new Editor({ prompt: "> ", initialText: "ab\ncd" });
    editor.render(20);
    expect(editor.getCursor()).toEqual({ row: 1, col: 4 });
  });

  it("accounts for wide characters in the cursor column", () => {
    const editor = new Editor({ prompt: "", initialText: "日本" });
    editor.render(20);
    expect(editor.getCursor()).toEqual({ row: 0, col: 4 });
  });

  it("scrolls the viewport to keep the caret visible", () => {
    const editor = new Editor({
      prompt: "",
      maxVisibleLines: 2,
      initialText: "1\n2\n3\n4",
    });
    const lines = editor.render(20).map(stripAnsi);
    expect(lines[0]).toBe("3");
    expect(lines[1]).toBe("4");
  });

  it("renders the completion dropdown below the buffer", () => {
    const editor = new Editor({
      prompt: "> ",
      autocomplete: { getSuggestions: () => [{ value: "@alpha" }, { value: "@beta" }] },
    });
    type(editor, "@");
    const lines = editor.render(30).map(stripAnsi);
    expect(lines.some((l) => l.includes("@alpha"))).toBe(true);
    expect(lines.some((l) => l.includes("@beta"))).toBe(true);
  });

  it("draws an inverse-video caret only when focused", () => {
    setColorLevel(ColorLevel.TrueColor);
    const editor = new Editor({ prompt: "", initialText: "ab" });
    expect(editor.render(10)[0]).not.toContain(`${ESC}[7m`);
    editor.onFocus();
    expect(editor.render(10)[0]).toContain(`${ESC}[7m`);
  });
});

describe("word boundaries", () => {
  it("finds the start of the previous word", () => {
    expect(wordBoundaryBackward("alpha beta", 10)).toBe(6);
    expect(wordBoundaryBackward("alpha beta", 6)).toBe(0);
    expect(wordBoundaryBackward("a.b", 3)).toBe(2);
  });

  it("finds the end of the next word", () => {
    expect(wordBoundaryForward("alpha beta", 0)).toBe(5);
    expect(wordBoundaryForward("alpha beta", 5)).toBe(10);
    expect(wordBoundaryForward("a.b", 1)).toBe(2);
  });
});
