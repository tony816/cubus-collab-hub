import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashMarkdown, normalizeMarkdown, scanVault } from "./vault.js";

describe("vault normalization", () => {
  it("normalizes BOM, Windows newlines, and terminal newline", () => {
    expect(normalizeMarkdown("\uFEFF# 제목\r\n본문")).toBe("# 제목\n본문\n");
  });

  it("scans markdown while excluding Obsidian internals", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubus-vault-"));
    await mkdir(join(root, ".obsidian"));
    await writeFile(join(root, ".obsidian", "hidden.md"), "hidden");
    await writeFile(join(root, "인물.md"), "---\ntitle: 리나\n---\n본문\n");
    const documents = await scanVault(root);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ path: "인물.md", title: "리나", expectedVersion: null });
    expect(documents[0]?.sha256).toBe(hashMarkdown(documents[0]?.content ?? ""));
  });
});

