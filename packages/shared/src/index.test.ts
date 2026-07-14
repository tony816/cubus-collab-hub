import { describe, expect, it } from "vitest";
import { ProposePatchInputSchema, UpsertDocumentInputSchema } from "./index.js";

describe("shared input schemas", () => {
  it("rejects a malformed document hash", () => {
    const result = UpsertDocumentInputSchema.safeParse({
      path: "01_허브/설정.md",
      title: "설정",
      content: "본문",
      frontmatter: {},
      sha256: "bad",
      byteCount: 6,
      expectedVersion: 0,
    });
    expect(result.success).toBe(false);
  });

  it("requires an explicit AI identity and base version", () => {
    const result = ProposePatchInputSchema.safeParse({
      targetPath: "01_허브/설정.md",
      proposedContent: "변경",
      rationale: "정합성 보정",
    });
    expect(result.success).toBe(false);
  });
});

