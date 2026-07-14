import { describe, expect, it } from "vitest";
import { ProposePatchInputSchema, RecordTurnSummaryInputSchema, UpsertDocumentInputSchema } from "./index.js";

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

  it("requires verbatim prompt and response, with summary optional", () => {
    const missing = RecordTurnSummaryInputSchema.safeParse({
      agent: "claude",
      seenSequence: 200,
      summary: "리나 생일 파티 정리",
    });
    expect(missing.success).toBe(false);

    const verbatim = RecordTurnSummaryInputSchema.safeParse({
      agent: "claude",
      seenSequence: 200,
      userPrompt: "리나 생일 파티 언제야?",
      responseText: "Ep.7 여름 합숙 중으로 확정입니다.",
    });
    expect(verbatim.success).toBe(true);
    expect(verbatim.success && verbatim.data.affectedPaths).toEqual([]);
  });
});

