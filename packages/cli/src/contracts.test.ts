import { describe, expect, it } from "vitest";
import {
  contractPromptLines,
  describeContractValue,
  extractContractJson,
  isContractParseError,
  parseContractBody,
  validateContract,
  type WorkflowContract,
  type WorkflowContractField,
} from "./contracts.js";

/** Parse a contract body and assert success, returning its fields. */
function fieldsOf(body: string, first = 10): readonly WorkflowContractField[] {
  const parsed = parseContractBody(body.split("\n"), first);
  if (isContractParseError(parsed)) throw new Error(`expected fields, got: ${parsed.error}`);
  return parsed.fields;
}

/** Parse a contract body and assert failure, returning the message. */
function bodyErr(body: string, first = 10): string {
  const parsed = parseContractBody(body.split("\n"), first);
  if (!isContractParseError(parsed)) throw new Error("expected a parse error");
  return parsed.error;
}

/** The worked example from the docs, as a contract object. */
const RELEASE: WorkflowContract = {
  name: "release-verdict",
  line: 20,
  fields: fieldsOf(
    [
      "decision: SHIP | SHIP-WITH-FIXES | DO-NOT-SHIP",
      "reasons: string[]",
      "blockers?: string[]",
      "confidence: number",
    ].join("\n"),
  ),
};

describe("parseContractBody", () => {
  it("reads fields, optionality and every built-in type", () => {
    const fields = fieldsOf(
      [
        "a: string",
        "b: number",
        "c: integer",
        "d: boolean",
        "e: string[]",
        "f: number[]",
        "g?: string",
      ].join("\n"),
    );
    expect(
      fields.map((field) => `${field.name}${field.optional ? "?" : ""}:${field.type.kind}`),
    ).toEqual([
      "a:string",
      "b:number",
      "c:integer",
      "d:boolean",
      "e:string[]",
      "f:number[]",
      "g?:string",
    ]);
  });

  it("reads an enum's members in written order", () => {
    const fields = fieldsOf("decision: SHIP | SHIP-WITH-FIXES | DO-NOT-SHIP");
    expect(fields[0]?.type).toEqual({
      kind: "enum",
      values: ["SHIP", "SHIP-WITH-FIXES", "DO-NOT-SHIP"],
    });
  });

  it("skips blank lines and # comments without counting them as fields", () => {
    expect(
      fieldsOf(["# what shipped", "", "ok: boolean", "   ", "# trailing note"].join("\n")),
    ).toHaveLength(1);
  });

  it("numbers every message against the whole file, not the block", () => {
    // Line 10 is the first body line, so the third body line is file line 12.
    expect(bodyErr(["a: string", "", "b: nope"].join("\n"), 10)).toBe(
      'line 12: unknown type "nope"; use string, number, integer, boolean, string[], number[], or an enum like "A | B"',
    );
  });

  it("rejects a malformed field line", () => {
    expect(bodyErr("just some prose")).toBe(
      'line 10: expected "<field>: <type>", got "just some prose"',
    );
    expect(bodyErr("decision:")).toBe('line 10: expected "<field>: <type>", got "decision:"');
    expect(bodyErr(": string")).toBe('line 10: expected "<field>: <type>", got ": string"');
  });

  it("rejects a bad field name, a duplicate field and a bad enum", () => {
    expect(bodyErr("2fast: string")).toBe(
      'line 10: contract field "2fast" may only contain letters, digits and "_", and must start with a letter',
    );
    expect(bodyErr(["a: string", "a: number"].join("\n"))).toBe(
      'line 11: contract field "a" appears twice',
    );
    expect(bodyErr("v: A | 2B")).toBe(
      'line 10: enum value "2B" may only contain letters, digits, "_" and "-", and must start with a letter',
    );
    expect(bodyErr("v: A | B | A")).toBe('line 10: enum value "A" appears twice');
    expect(bodyErr("v: A |")).toBe(
      'line 10: unknown type "A |"; use string, number, integer, boolean, string[], number[], or an enum like "A | B"',
    );
  });

  it("returns no fields for an empty body — emptiness is the caller's error", () => {
    expect(fieldsOf("")).toEqual([]);
    expect(fieldsOf("# only a comment")).toEqual([]);
  });
});

describe("extractContractJson", () => {
  it("takes the block even when prose follows the closing fence", () => {
    const reply = [
      "Here is my verdict.",
      "```json",
      '{"ok": true}',
      "```",
      "Hope that helps!",
    ].join("\n");
    expect(extractContractJson(reply)).toEqual({ ok: true, value: { ok: true } });
  });

  it("takes the LAST block when the reply quotes an example first", () => {
    const reply = [
      "For example:",
      "```json",
      '{"decision": "SHIP"}',
      "```",
      "My actual answer:",
      "```json",
      '{"decision": "DO-NOT-SHIP"}',
      "```",
    ].join("\n");
    expect(extractContractJson(reply)).toEqual({
      ok: true,
      value: { decision: "DO-NOT-SHIP" },
    });
  });

  it("reads an unterminated final fence to the end of the reply", () => {
    expect(extractContractJson(["```json", '{"a": 1}'].join("\n"))).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("says so when there is no fence, an empty fence, or unparsable content", () => {
    expect(extractContractJson("no json here at all")).toEqual({
      ok: false,
      error: "the reply has no fenced json block",
    });
    // A bare ``` fence with no `json` info string is not the block we asked for.
    expect(extractContractJson(["```", '{"a": 1}', "```"].join("\n"))).toEqual({
      ok: false,
      error: "the reply has no fenced json block",
    });
    expect(extractContractJson(["```json", "```"].join("\n"))).toEqual({
      ok: false,
      error: "the reply's fenced json block is empty",
    });
    const broken = extractContractJson(["```json", "{oops}", "```"].join("\n"));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toMatch(/^the fenced json block is not valid json: /);
  });
});

describe("validateContract", () => {
  const value = {
    decision: "SHIP",
    reasons: ["tests pass"],
    confidence: 0.9,
  };

  it("accepts a well-formed object, optional field absent", () => {
    expect(validateContract(RELEASE, value)).toEqual({ ok: true, value });
  });

  it("names the enum's members when the value is not one of them", () => {
    const bad = validateContract(RELEASE, { ...value, decision: "MAYBE" });
    expect(bad).toEqual({
      ok: false,
      errors: ['decision: expected one of SHIP, SHIP-WITH-FIXES, DO-NOT-SHIP, got "MAYBE"'],
    });
  });

  it("collects every problem at once — the set is the retry instruction", () => {
    const bad = validateContract(RELEASE, { decision: "SHIP", reasons: "nope", extra: 1 });
    expect(bad).toEqual({
      ok: false,
      errors: [
        "reasons: expected string[]",
        "missing required field confidence",
        "unknown field extra",
      ],
    });
  });

  it("treats an undeclared field as an error — contracts are exact", () => {
    expect(validateContract(RELEASE, { ...value, verdict: "SHIP" })).toEqual({
      ok: false,
      errors: ["unknown field verdict"],
    });
  });

  it("treats null like absence: fine for an optional field, missing for a required one", () => {
    expect(validateContract(RELEASE, { ...value, blockers: null })).toEqual({
      ok: true,
      value: { ...value, blockers: null },
    });
    expect(validateContract(RELEASE, { ...value, confidence: null }).ok).toBe(false);
  });

  it("holds each built-in type to its own rule", () => {
    const contract = (type: string): WorkflowContract => ({
      name: "t",
      line: 1,
      fields: fieldsOf(`v: ${type}`),
    });
    const errors = (type: string, v: unknown): string[] => {
      const result = validateContract(contract(type), { v });
      return result.ok ? [] : result.errors;
    };
    expect(errors("integer", 1.5)).toEqual(["v: expected integer"]);
    expect(errors("integer", 2)).toEqual([]);
    expect(errors("number", Number.NaN)).toEqual(["v: expected number"]);
    expect(errors("number", "0.5")).toEqual(["v: expected number"]);
    expect(errors("number", 0.5)).toEqual([]);
    expect(errors("boolean", "true")).toEqual(["v: expected boolean"]);
    expect(errors("string", 3)).toEqual(["v: expected string"]);
    expect(errors("string[]", ["a", 1])).toEqual(["v: expected string[]"]);
    expect(errors("string[]", [])).toEqual([]);
    expect(errors("number[]", [1, "2"])).toEqual(["v: expected number[]"]);
    expect(errors("number[]", [1, Number.POSITIVE_INFINITY])).toEqual(["v: expected number[]"]);
  });

  it("rejects anything that is not a json object", () => {
    for (const value of [null, 42, "text", [1, 2]]) {
      expect(validateContract(RELEASE, value)).toEqual({
        ok: false,
        errors: ["expected a json object"],
      });
    }
  });
});

describe("contractPromptLines", () => {
  it("states the shape, every field, and the two enforced rules", () => {
    expect(contractPromptLines(RELEASE)).toEqual([
      "End your reply with one fenced ```json block containing exactly these fields:",
      "- decision: exactly one of SHIP, SHIP-WITH-FIXES, DO-NOT-SHIP",
      "- reasons: an array of strings",
      "- blockers (optional): an array of strings",
      "- confidence: a number",
      "Add no other fields, and put nothing after the closing fence.",
    ]);
  });

  it("spells every built-in type in words a model can follow", () => {
    const all: WorkflowContract = {
      name: "all",
      line: 1,
      fields: fieldsOf(
        ["a: string", "b: number", "c: integer", "d: boolean", "e: string[]", "f: number[]"].join(
          "\n",
        ),
      ),
    };
    expect(contractPromptLines(all).slice(1, -1)).toEqual([
      "- a: a string",
      "- b: a number",
      "- c: a whole number",
      "- d: true or false",
      "- e: an array of strings",
      "- f: an array of numbers",
    ]);
  });
});

describe("describeContractValue", () => {
  it("summarises the scalars and leaves the arrays out", () => {
    expect(
      describeContractValue(RELEASE, {
        decision: "DO-NOT-SHIP",
        reasons: ["flaky suite", "no rollback"],
        confidence: 0.8,
      }),
    ).toBe("decision=DO-NOT-SHIP confidence=0.8");
  });

  it("skips an absent optional field", () => {
    expect(describeContractValue(RELEASE, { decision: "SHIP", reasons: [], confidence: 1 })).toBe(
      "decision=SHIP confidence=1",
    );
  });

  it("falls back to a size when a contract carries no scalar to headline", () => {
    const arrays: WorkflowContract = {
      name: "notes",
      line: 1,
      fields: fieldsOf("items: string[]"),
    };
    expect(describeContractValue(arrays, { items: ["a"] })).toBe("notes: 1 field");
  });
});
