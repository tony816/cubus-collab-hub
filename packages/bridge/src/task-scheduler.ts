import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { stateDirectory } from "./config.js";

const execFileAsync = promisify(execFile);

// The startup script must leave evidence in task-output.log on every launch:
// a silent no-show at logon (the original design) was undiagnosable. Marker
// echoes and the watcher's console output go to separate files, because the
// long-lived `>>` redirect holds its file locked against other cmd writers.
function runnerScript(repositoryRoot: string, markerLogPath: string, consoleLogPath: string): string {
  const npmCmd = join(dirname(process.execPath), "npm.cmd");
  const npm = existsSync(npmCmd) ? `"${npmCmd}"` : "npm";
  return [
    "@echo off",
    "setlocal",
    `set "LOG=${markerLogPath}"`,
    'echo [%date% %time%] start-bridge.cmd launched >> "%LOG%"',
    "",
    "rem single-instance guard: skip if a bridge watcher is already running",
    "powershell -NoProfile -Command \"if (Get-CimInstance Win32_Process -Filter \\\"Name like '%%node%%'\\\" | Where-Object { $_.CommandLine -match 'cli\\.ts watch' }) { exit 1 } else { exit 0 }\"",
    "if errorlevel 1 (",
    '  echo [%date% %time%] bridge already running, skipping >> "%LOG%"',
    "  exit /b 0",
    ")",
    "",
    `cd /d "${repositoryRoot}" || (`,
    '  echo [%date% %time%] ERROR: repository path missing >> "%LOG%"',
    "  exit /b 1",
    ")",
    'echo [%date% %time%] starting bridge watcher >> "%LOG%"',
    `call ${npm} run bridge -- watch >> "${consoleLogPath}" 2>&1`,
    'echo [%date% %time%] bridge watcher exited with code %errorlevel% >> "%LOG%"',
    "",
  ].join("\r\n");
}

export async function installLoginTask(repositoryRoot: string): Promise<"task-scheduler" | "user-run-key"> {
  await mkdir(stateDirectory(), { recursive: true });
  const runner = join(stateDirectory(), "start-bridge.cmd");
  const hiddenLauncher = join(stateDirectory(), "start-bridge-hidden.vbs");
  const root = resolve(repositoryRoot);

  await writeFile(runner, runnerScript(
    root,
    join(stateDirectory(), "task-output.log"),
    join(stateDirectory(), "bridge-console.log"),
  ), "utf8");
  // wscript runs the batch with a hidden window, so logon does not flash (or
  // strand) a console the user might close and kill the watcher with.
  await writeFile(hiddenLauncher, [
    "' Launches the CUBUS bridge startup script without a visible console window.",
    `CreateObject("WScript.Shell").Run """${runner}""", 0, False`,
    "",
  ].join("\r\n"), "utf8");

  const launchCommand = `wscript.exe "${hiddenLauncher}"`;
  try {
    await execFileAsync("schtasks.exe", [
      "/Create", "/F", "/SC", "ONLOGON", "/TN", "CUBUS Collab Bridge",
      "/TR", launchCommand,
    ]);
    return "task-scheduler";
  } catch {
    await execFileAsync("reg.exe", [
      "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v", "CUBUS Collab Bridge", "/t", "REG_SZ", "/d", launchCommand, "/f",
    ]);
    return "user-run-key";
  }
}
