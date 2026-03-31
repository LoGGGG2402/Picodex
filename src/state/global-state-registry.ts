import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveCodexHomePath } from "../desktop/codex-home.js";

export interface LoadedGlobalStateRegistry {
  found: boolean;
  state: Record<string, unknown>;
}

export function deriveGlobalStateRegistryPath(): string {
  return join(resolveCodexHomePath(), "picodex", "global-state.json");
}

export async function loadGlobalStateRegistry(
  registryPath: string,
): Promise<LoadedGlobalStateRegistry> {
  try {
    const raw = await readFile(registryPath, "utf8");
    return {
      found: true,
      state: parseGlobalStateRegistry(raw),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        found: false,
        state: {},
      };
    }
    throw error;
  }
}

export async function saveGlobalStateRegistry(
  registryPath: string,
  state: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        state,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function parseGlobalStateRegistry(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!isJsonRecord(parsed) || !isJsonRecord(parsed.state)) {
    return {};
  }

  return { ...parsed.state };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
