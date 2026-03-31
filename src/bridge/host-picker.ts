import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve, sep } from "node:path";

import { debugLog } from "../core/debug.js";
import { isJsonRecord, normalizeError, normalizeNonEmptyString } from "./utils.js";

export async function pickDirectoryOnHost(preferredPath: string): Promise<string | null> {
  const startPath = resolveExistingDirectory(preferredPath);
  switch (platform()) {
    case "darwin":
      return pickDirectoryOnMac(startPath);
    case "linux":
      return pickDirectoryOnLinux(startPath);
    default:
      throw new Error("Native folder picker is not supported on this host.");
  }
}

function execFileText(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveOutput(stdout.trim());
      },
    );
  });
}

async function pickDirectoryOnMac(startPath: string): Promise<string | null> {
  const script = [
    "try",
    `set chosenFolder to choose folder with prompt "Choose a workspace folder for Picodex." default location POSIX file "${escapeAppleScriptString(startPath)}"`,
    "return POSIX path of chosenFolder",
    "on error number -128",
    'return ""',
    "end try",
  ].join("\n");
  const stdout = await execFileText("osascript", ["-e", script], startPath);
  const picked = stdout.trim();
  return picked.length > 0 ? resolve(picked) : null;
}

async function pickDirectoryOnLinux(startPath: string): Promise<string | null> {
  const zenityArgs = [
    "--file-selection",
    "--directory",
    "--title=Choose a workspace folder for Picodex",
    "--filename",
    ensureTrailingSlash(startPath),
  ];
  try {
    const stdout = await execFileText("zenity", zenityArgs, startPath);
    return normalizeNonEmptyString(stdout);
  } catch (error) {
    if (isExecCancel(error)) {
      return null;
    }
    if (!isExecMissing(error)) {
      debugLog("app-server", "zenity folder picker failed", {
        error: normalizeError(error).message,
      });
    }
  }

  try {
    const stdout = await execFileText(
      "kdialog",
      ["--getexistingdirectory", startPath, "--title", "Choose a workspace folder for Picodex"],
      startPath,
    );
    return normalizeNonEmptyString(stdout);
  } catch (error) {
    if (isExecCancel(error)) {
      return null;
    }
    if (!isExecMissing(error)) {
      debugLog("app-server", "kdialog folder picker failed", {
        error: normalizeError(error).message,
      });
    }
  }

  throw new Error(
    "Native folder picker is unavailable on this Linux host. Install zenity or kdialog, or enter the path manually.",
  );
}

function resolveExistingDirectory(preferredPath: string): string {
  let candidate = resolve(preferredPath);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      return homedir();
    }
    candidate = parent;
  }

  try {
    return statSync(candidate).isDirectory() ? candidate : dirname(candidate);
  } catch {
    return homedir();
  }
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isExecMissing(error: unknown): boolean {
  return isJsonRecord(error) && error.code === "ENOENT";
}

function isExecCancel(error: unknown): boolean {
  return isJsonRecord(error) && error.code === 1;
}
