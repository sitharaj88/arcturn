import { describe, expect, it } from "vitest";
import { nextRequestId, RequestIdGenerator } from "./request-id.js";

describe("nextRequestId / RequestIdGenerator", () => {
  it("produces monotonically distinct ids from the shared generator", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(nextRequestId());
    expect(ids.size).toBe(1000);
  });

  it("shares a stable random prefix within one generator instance", () => {
    const gen = new RequestIdGenerator();
    const a = gen.next();
    const b = gen.next();
    const prefixA = a.split("-")[0];
    const prefixB = b.split("-")[0];
    expect(prefixA).toBe(prefixB);
    expect(a).not.toBe(b);
  });

  it("gives independent generators different prefixes (collision-resistant)", () => {
    const genA = new RequestIdGenerator();
    const genB = new RequestIdGenerator();
    expect(genA.next().split("-")[0]).not.toBe(genB.next().split("-")[0]);
  });

  it("returns ids as non-empty strings suitable for use as ClientRequest.id", () => {
    const id = nextRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
