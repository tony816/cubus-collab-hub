import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { stateDirectory } from "./config.js";

const execFileAsync = promisify(execFile);

export async function installLoginTask(repositoryRoot: string): Promise<void> {
  await mkdir(stateDirectory(), { recursive: true });
  const runner = join(stateDirectory(), "start-bridge.cmd");
  const root = resolve(repositoryRoot);
  const content = `@echo off\r\ncd /d "${root}"\r\nnpm run bridge -- watch >> "${join(stateDirectory(), "task-output.log")}" 2>&1\r\n`;
  await writeFile(runner, content, "utf8");
  await execFileAsync("schtasks.exe", [
    "/Create", "/F", "/SC", "ONLOGON", "/TN", "CUBUS Collab Bridge",
    "/TR", `"${runner}"`,
  ]);
}
