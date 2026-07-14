import { describe, expect, it } from "vitest";
import { bearerToken, sealState, secureEqual, securityHeaders, sha256Hex, unsealState } from "./security.js";

const stateSecret = "test-only-cookie-encryption-key-32-chars";

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

  it("round-trips sealed OAuth state", async () => {
    const state = await sealState({ clientId: "claude", scope: ["mcp"] }, stateSecret);
    await expect(unsealState(state, stateSecret)).resolves.toEqual({ clientId: "claude", scope: ["mcp"] });
  });

  it("allows the GitHub OAuth redirect through form-action", () => {
    expect(securityHeaders()["Content-Security-Policy"]).toContain("form-action 'self' https://github.com");
  });

  it("rejects tampered and expired OAuth state", async () => {
    const state = await sealState({ clientId: "claude" }, stateSecret, 1);
    const replacement = state.endsWith("A") ? "B" : "A";
    await expect(unsealState(`${state.slice(0, -1)}${replacement}`, stateSecret)).resolves.toBeNull();
    await expect(unsealState(state, stateSecret, Date.now() + 1_001)).resolves.toBeNull();
  });
});
