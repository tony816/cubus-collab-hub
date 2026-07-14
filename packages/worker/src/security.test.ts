import { describe, expect, it } from "vitest";
import { bearerToken, secureEqual, sha256Hex } from "./security.js";

describe("worker security helpers", () => {
  it("compares secrets through fixed-size hashes", async () => {
    await expect(secureEqual("same", "same")).resolves.toBe(true);
    await expect(secureEqual("short", "a much longer value")).resolves.toBe(false);
  });

  it("hashes UTF-8 deterministically", async () => {
    await expect(sha256Hex("CUBUS")).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts only bearer authorization", () => {
    expect(bearerToken(new Request("https://example.test", { headers: { Authorization: "Bearer token" } }))).toBe("token");
    expect(bearerToken(new Request("https://example.test", { headers: { Authorization: "Basic token" } }))).toBe("");
  });
});

