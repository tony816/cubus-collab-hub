import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import type { UpsertDocumentInput } from "@cubus/shared";

const ignoredDirectories = new Set([".git", ".obsidian", "node_modules"]);

function shouldIgnore(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~") || name.endsWith(".tmp") || name.endsWith(".temp");
}

export function normalizeMarkdown(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export function hashMarkdown(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeRelativePath(root: string, file: string): string {
  const path = relative(resolve(root), resolve(file)).split(sep).join("/");
  if (path.startsWith("../") || path === "..") throw new Error(`File is outside vault: ${file}`);
  return path.normalize("NFC");
}

export async function markdownFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        found.push(fullPath);
      }
    }
  }
  await walk(resolve(root));
  return found.sort((a, b) => a.localeCompare(b, "ko"));
}

export async function readVaultDocument(root: string, file: string, expectedVersion: number | null): Promise<UpsertDocumentInput> {
  const content = normalizeMarkdown(await readFile(file, "utf8"));
  const parsed = matter(content);
  const relativePath = normalizeRelativePath(root, file);
  const heading = parsed.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const frontmatterTitle = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
  const title = frontmatterTitle || heading || basename(relativePath, ".md");
  return {
    path: relativePath,
    title,
    content,
    frontmatter: parsed.data,
    sha256: hashMarkdown(content),
    byteCount: Buffer.byteLength(content, "utf8"),
    expectedVersion,
    origin: "obsidian",
  };
}

export async function scanVault(root: string, versions: Map<string, number> = new Map()): Promise<UpsertDocumentInput[]> {
  const files = await markdownFiles(root);
  return Promise.all(files.map(async (file) => {
    const path = normalizeRelativePath(root, file);
    return readVaultDocument(root, file, versions.get(path) ?? null);
  }));
}
