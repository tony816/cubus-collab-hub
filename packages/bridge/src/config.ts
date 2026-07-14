import { Entry } from "@napi-rs/keyring";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const serviceName = "cubus-collab-hub";
const credentialName = "bridge-api-token";

export type BridgeConfig = {
  apiUrl: string;
  vaultPath: string;
  pollIntervalMs: number;
};

export function stateDirectory(): string {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "cubus-collab-hub")
    : join(homedir(), ".cubus-collab-hub");
}

export function configPath(): string {
  return join(stateDirectory(), "config.json");
}

export function syncStatePath(): string {
  return join(stateDirectory(), "sync-state.json");
}

export function logPath(): string {
  return join(stateDirectory(), "bridge.log");
}

export async function saveConfig(config: BridgeConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function loadConfig(): Promise<BridgeConfig> {
  const fromEnvironment = process.env.CUBUS_API_URL;
  try {
    const config = JSON.parse(await readFile(configPath(), "utf8")) as BridgeConfig;
    return { ...config, apiUrl: fromEnvironment ?? config.apiUrl };
  } catch {
    if (!fromEnvironment) throw new Error("Bridge is not configured. Run: npm run bridge -- configure <API_URL> <VAULT_PATH>");
    return { apiUrl: fromEnvironment, vaultPath: "", pollIntervalMs: 7500 };
  }
}

export function setBridgeToken(token: string): void {
  if (token.length < 24) throw new Error("Bridge token must be at least 24 characters");
  new Entry(serviceName, credentialName).setPassword(token);
}

export function getBridgeToken(): string {
  const fromEnvironment = process.env.CUBUS_BRIDGE_TOKEN;
  if (fromEnvironment) return fromEnvironment;
  const token = new Entry(serviceName, credentialName).getPassword();
  if (!token) throw new Error("Bridge token is missing. Run: npm run bridge -- auth-set <TOKEN>");
  return token;
}
