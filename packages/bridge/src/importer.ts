import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UpsertDocumentInput } from "@cubus/shared";
import { HubClient, type ManifestRow, type UpsertResult } from "./client.js";
import { scanVault } from "./vault.js";

const maxBatchBytes = 2_200_000;

function batches(documents: UpsertDocumentInput[]): UpsertDocumentInput[][] {
  const result: UpsertDocumentInput[][] = [];
  let current: UpsertDocumentInput[] = [];
  let currentBytes = 0;
  for (const document of documents) {
    const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
    if (current.length > 0 && (current.length >= 50 || currentBytes + bytes > maxBatchBytes)) {
      result.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(document);
    currentBytes += bytes;
  }
  if (current.length > 0) result.push(current);
  return result;
}

export type MigrationReport = {
  generatedAt: string;
  vaultPath: string;
  local: { count: number; bytes: number };
  remote: { count: number; bytes: number };
  upload: Record<UpsertResult["status"], number>;
  missingRemote: string[];
  unexpectedRemote: string[];
  hashMismatches: string[];
  verified: boolean;
};

export async function importVault(client: HubClient, vaultPath: string, reportDirectory: string): Promise<MigrationReport> {
  const existing = await client.manifest();
  const versions = new Map(existing.map((row) => [row.path, row.version]));
  const documents = await scanVault(vaultPath, versions);
  const results: UpsertResult[] = [];
  for (const batch of batches(documents)) {
    results.push(...await client.upsertBatch(batch));
  }
  const remote = await client.manifest();
  const report = verify(documents, remote, results, vaultPath);
  await writeFile(join(reportDirectory, "migration-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export async function verifyVault(client: HubClient, vaultPath: string): Promise<MigrationReport> {
  const documents = await scanVault(vaultPath);
  return verify(documents, await client.manifest(), [], vaultPath);
}

function verify(
  local: UpsertDocumentInput[],
  remote: ManifestRow[],
  results: UpsertResult[],
  vaultPath: string,
): MigrationReport {
  const localMap = new Map(local.map((document) => [document.path, document]));
  const remoteMap = new Map(remote.map((document) => [document.path, document]));
  const missingRemote = [...localMap.keys()].filter((path) => !remoteMap.has(path));
  const unexpectedRemote = [...remoteMap.keys()].filter((path) => !localMap.has(path));
  const hashMismatches = [...localMap].filter(([path, document]) => remoteMap.get(path)?.sha256 !== document.sha256).map(([path]) => path);
  const statuses: Record<UpsertResult["status"], number> = {
    created: 0, updated: 0, unchanged: 0, conflict: 0, renamed: 0, deleted: 0,
  };
  for (const result of results) statuses[result.status] += 1;
  const report: MigrationReport = {
    generatedAt: new Date().toISOString(),
    vaultPath,
    local: { count: local.length, bytes: local.reduce((sum, document) => sum + document.byteCount, 0) },
    remote: { count: remote.length, bytes: remote.reduce((sum, document) => sum + document.byte_count, 0) },
    upload: statuses,
    missingRemote,
    unexpectedRemote,
    hashMismatches,
    verified: missingRemote.length === 0 && unexpectedRemote.length === 0 && hashMismatches.length === 0,
  };
  return report;
}
