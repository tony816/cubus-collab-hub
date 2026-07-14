import { describe, expect, it } from "vitest";
import { MAX_TURN_RESPONSE_CHARS } from "@cubus/shared";
import { truncateTurnText } from "./service.js";

describe("verbatim turn text", () => {
  it("keeps text at or under the limit unchanged", () => {
    const text = "리나 생일 파티는 Ep.7로 확정.";
    expect(truncateTurnText(text, MAX_TURN_RESPONSE_CHARS)).toBe(text);
  });

  it("truncates oversized text and marks the dropped length", () => {
    const text = "가".repeat(MAX_TURN_RESPONSE_CHARS + 25);
    const result = truncateTurnText(text, MAX_TURN_RESPONSE_CHARS);
    expect(result.startsWith("가".repeat(MAX_TURN_RESPONSE_CHARS))).toBe(true);
    expect(result).toContain("25자 잘림");
    expect(result.length).toBeLessThan(text.length + 20);
  });
});
