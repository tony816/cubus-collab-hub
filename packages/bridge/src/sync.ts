import chokidar from "chokidar";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HubClient, type ManifestRow, type UpsertResult } from "./client.js";
import { logPath, syncStatePath } from "./config.js";
import { hashMarkdown, normalizeMarkdown, normalizeRelativePath, readVaultDocument, scanVault } from "./vault.js";

type SyncState = {
  cursor: number;
  hashes: Record<string, string>;
  versions: Record<string, number>;
};

const emptyState: SyncState = { cursor: 0, hashes: {}, versions: {} };

async function log(message: string, details: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dirname(logPath()), { recursive: true });
  await appendFile(logPath(), `${JSON.stringify({ at: new Date().toISOString(), message, ...details })}\n`, "utf8");
}

async function loadState(): Promise<SyncState> {
  try {
    const state = JSON.parse(await readFile(syncStatePath(), "utf8")) as SyncState;
    return { cursor: state.cursor, hashes: state.hashes, versions: state.versions };
  } catch {
    return structuredClone(emptyState);
  }
}

async function saveState(state: SyncState): Promise<void> {
  await mkdir(dirname(syncStatePath()), { recursive: true });
  const temporary = `${syncStatePath()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, syncStatePath());
}

function safeVaultFile(vaultPath: string, relativePath: string): string {
  const root = resolve(vaultPath);
  const file = resolve(root, ...relativePath.split("/"));
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  if (file !== root && !file.startsWith(prefix)) throw new Error(`Unsafe remote path: ${relativePath}`);
  return file;
}

async function fileHash(file: string): Promise<string | null> {
  try {
    return hashMarkdown(normalizeMarkdown(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}

async function writeAtomically(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.cubus-tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

async function writeConflict(vaultPath: string, path: string, local: string, remote: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = path.replace(/[\\/:*?"<>|]/g, "_");
  const output = safeVaultFile(vaultPath, `07_충돌_검토/자동_충돌_${stamp}_${safeName}`);
  const content = `---\ntype: sync-conflict\nsource_path: ${JSON.stringify(path)}\ncreated_at: ${new Date().toISOString()}\n---\n# 동기화 충돌: ${path}\n\n## 로컬 내용\n\n${local}\n\n## 승인된 원격 내용\n\n${remote}\n`;
  await writeAtomically(output, content);
  await log("conflict file written", { path, output });
}

function applyResult(state: SyncState, path: string, hash: string, result: UpsertResult): void {
  if (result.status === "conflict") return;
  state.hashes[path] = hash;
  if (result.version !== undefined) state.versions[path] = result.version;
}

async function reconcile(client: HubClient, vaultPath: string, state: SyncState, manifest: ManifestRow[]): Promise<void> {
  const remote = new Map(manifest.map((row) => [row.path, row]));
  const local = await scanVault(vaultPath, new Map(manifest.map((row) => [row.path, row.version])));
  for (const document of local) {
    const known = remote.get(document.path);
    if (known?.sha256 === document.sha256) {
      state.hashes[document.path] = document.sha256;
      state.versions[document.path] = known.version;
      continue;
    }
    const result = await client.upsert(document);
    applyResult(state, document.path, document.sha256, result);
    if (result.status === "conflict") await log("startup conflict", { path: document.path, conflictId: result.conflictId });
  }
  await saveState(state);
}

async function pullRemote(client: HubClient, vaultPath: string, state: SyncState): Promise<void> {
  const events = await client.events(state.cursor);
  for (const event of events) {
    try {
      if (["document.created", "document.updated", "proposal.approved"].includes(event.kind)) {
        const path = typeof event.metadata.path === "string" ? event.metadata.path : null;
        if (path) {
          const remote = await client.document(path);
          const file = safeVaultFile(vaultPath, path);
          const localHash = await fileHash(file);
          if (localHash !== remote.sha256) {
            const lastSyncedHash = state.hashes[path];
            if (localHash && lastSyncedHash && localHash !== lastSyncedHash) {
              await writeConflict(vaultPath, path, await readFile(file, "utf8"), remote.content);
            } else {
              await writeAtomically(file, remote.content);
              await log("remote document applied", { path, version: remote.version });
            }
          }
          state.hashes[path] = remote.sha256;
          state.versions[path] = remote.version;
        }
      }
    } finally {
      state.cursor = Math.max(state.cursor, event.sequence);
    }
  }
  if (events.length > 0) await saveState(state);
}

export async function watchVault(client: HubClient, vaultPath: string, pollIntervalMs: number): Promise<never> {
  await stat(vaultPath);
  const state = await loadState();
  await reconcile(client, vaultPath, state, await client.manifest());
  const pending = new Map<string, NodeJS.Timeout>();
  const recentUnlinks = new Map<string, { path: string; hash: string; version: number; timer: NodeJS.Timeout }>();

  const watcher = chokidar.watch(vaultPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 150 },
    ignored: (path) => path.includes("\\.obsidian\\") || path.endsWith(".cubus-tmp") || path.includes("자동_충돌_"),
  });

  watcher.on("add", (file) => { schedule(file, true); })
    .on("change", (file) => { schedule(file, false); })
    .on("unlink", (file) => { scheduleDelete(file); })
    .on("error", (error) => {
    void log("watcher error", { error: error instanceof Error ? error.message : String(error) });
  });

  function schedule(file: string, isAdd: boolean): void {
    if (!file.toLowerCase().endsWith(".md")) return;
    const existing = pending.get(file);
    if (existing) clearTimeout(existing);
    pending.set(file, setTimeout(() => {
      pending.delete(file);
      void push(file, isAdd).catch(async (error: unknown) => log("push failed", {
        file,
        error: error instanceof Error ? error.message : String(error),
      }));
    }, 1500));
  }

  function scheduleDelete(file: string): void {
    if (!file.toLowerCase().endsWith(".md")) return;
    const path = normalizeRelativePath(vaultPath, file);
    const hash = state.hashes[path];
    const version = state.versions[path];
    if (!hash || !version) return;
    const timer = setTimeout(() => {
      recentUnlinks.delete(path);
      void client.deleteDocument(path, version).then(async (result) => {
        Reflect.deleteProperty(state.hashes, path);
        Reflect.deleteProperty(state.versions, path);
        await saveState(state);
        await log("local document deleted", { path, status: result.status });
      }).catch(async (error: unknown) => log("delete failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      }));
    }, 4000);
    recentUnlinks.set(path, { path, hash, version, timer });
  }

  async function push(file: string, isAdd: boolean): Promise<void> {
    const path = normalizeRelativePath(vaultPath, file);
    const document = await readVaultDocument(vaultPath, file, state.versions[path] ?? null);
    if (isAdd) {
      const renamed = [...recentUnlinks.values()].find((candidate) => candidate.hash === document.sha256);
      if (renamed) {
        clearTimeout(renamed.timer);
        recentUnlinks.delete(renamed.path);
        const result = await client.renameDocument(renamed.path, path, renamed.version);
        Reflect.deleteProperty(state.hashes, renamed.path);
        Reflect.deleteProperty(state.versions, renamed.path);
        state.hashes[path] = document.sha256;
        if (result.version !== undefined) state.versions[path] = result.version;
        await saveState(state);
        await log("local document renamed", { oldPath: renamed.path, path, version: result.version });
        return;
      }
    }
    if (state.hashes[path] === document.sha256) return;
    const result = await client.upsert(document);
    applyResult(state, path, document.sha256, result);
    await saveState(state);
    await log("local document pushed", { path, status: result.status, version: result.version, conflictId: result.conflictId });
  }

  const timer = setInterval(() => {
    void pullRemote(client, vaultPath, state).catch(async (error: unknown) => log("pull failed", {
      error: error instanceof Error ? error.message : String(error),
    }));
  }, pollIntervalMs);

  await log("bridge started", { vaultPath, pollIntervalMs });
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      clearInterval(timer);
      void watcher.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  throw new Error("Bridge stopped");
}
