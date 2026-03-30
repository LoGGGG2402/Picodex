import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveCodexHomePath(): string {
  const rawValue = process.env.CODEX_HOME;
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (trimmed.length > 0 && trimmed.toLowerCase() !== "undefined") {
      return resolve(trimmed);
    }
  }

  return join(homedir(), ".codex");
}
