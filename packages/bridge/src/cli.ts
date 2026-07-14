import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HubClient } from "./client.js";
import { type BridgeConfig, getBridgeToken, loadConfig, saveConfig, setBridgeToken, stateDirectory } from "./config.js";
import { importVault, verifyVault } from "./importer.js";
import { watchVault } from "./sync.js";
import { installLoginTask } from "./task-scheduler.js";

function usage(): never {
  console.error(`Usage:
  npm run bridge -- configure <API_URL> <VAULT_PATH>
  npm run bridge -- auth-set <BRIDGE_TOKEN>
  npm run bridge -- import
  npm run bridge -- verify
  npm run bridge -- watch
  npm run bridge -- install-task`);
  process.exit(2);
}

const [, , command, ...args] = process.argv;
if (!command) usage();

if (command === "configure") {
  const [apiUrl, vaultPath] = args;
  if (!apiUrl || !vaultPath) usage();
  const url = new URL(apiUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("API URL must use HTTPS");
  const config: BridgeConfig = { apiUrl: url.href, vaultPath: resolve(vaultPath), pollIntervalMs: 7500 };
  await saveConfig(config);
  console.log(`Saved bridge configuration to ${stateDirectory()}`);
} else if (command === "auth-set") {
  const [token] = args;
  if (!token) usage();
  setBridgeToken(token);
  console.log("Stored bridge token in Windows Credential Manager");
} else {
  const config = await loadConfig();
  const client = new HubClient(config.apiUrl, getBridgeToken());
  if (command === "import") {
    await mkdir(stateDirectory(), { recursive: true });
    const report = await importVault(client, config.vaultPath, stateDirectory());
    console.log(JSON.stringify(report, null, 2));
    if (!report.verified) process.exitCode = 1;
  } else if (command === "verify") {
    const report = await verifyVault(client, config.vaultPath);
    console.log(JSON.stringify(report, null, 2));
    if (!report.verified) process.exitCode = 1;
  } else if (command === "watch") {
    await watchVault(client, config.vaultPath, config.pollIntervalMs);
  } else if (command === "install-task") {
    const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    await installLoginTask(repositoryRoot);
    console.log("Installed Windows login task: CUBUS Collab Bridge");
  } else {
    usage();
  }
}

