import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";

import { WORKTREE_CONFIG_VALUE_PREFIX } from "./shared.js";
import type { JsonRecord } from "../core/protocol.js";

export function buildIpcErrorResponse(requestId: string, error: string): JsonRecord {
  return {
    requestId,
    type: "response",
    resultType: "error",
    error,
  };
}

export function buildIpcSuccessResponse(requestId: string, result: unknown): JsonRecord {
  return {
    requestId,
    type: "response",
    resultType: "success",
    result,
  };
}

export function buildJsonRpcError(code: number, message: string): JsonRecord {
  return {
    code,
    message,
  };
}

export function execFileText(file: string, args: string[], cwd: string): Promise<string> {
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

export function extractJsonRpcErrorMessage(error: unknown): string {
  if (isJsonRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function parseResponseBody(bodyText: string): unknown {
  if (!bodyText) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

export function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!isJsonRecord(headers)) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function normalizeRequestBody(body: unknown): BodyInit | undefined {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body === null || body === undefined) {
    return undefined;
  }
  return JSON.stringify(body);
}

export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeInteger(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

export function normalizePositiveInteger(value: unknown): number | null {
  const normalized = normalizeInteger(value);
  return normalized !== null && normalized > 0 ? normalized : null;
}

export function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeExperimentalFeatureEnablementMap(
  value: unknown,
): Record<string, boolean> {
  if (!isJsonRecord(value)) {
    return {};
  }

  const normalized: Record<string, boolean> = {};
  for (const [featureName, enabled] of Object.entries(value)) {
    const trimmedName = featureName.trim();
    if (trimmedName.length === 0 || typeof enabled !== "boolean") {
      continue;
    }
    normalized[trimmedName] = enabled;
  }
  return normalized;
}

export function parseExperimentalFeatureCursor(cursor: string | null): number {
  if (!cursor) {
    return 0;
  }

  const parsed = Number.parseInt(cursor, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function hasNonEmptyString(value: unknown): value is string {
  return normalizeNonEmptyString(value) !== null;
}

export function hasSubagentThreadSource(source: unknown): boolean {
  return (
    isJsonRecord(source) &&
    isJsonRecord(source.subAgent) &&
    isJsonRecord(source.subAgent.thread_spawn) &&
    typeof source.subAgent.thread_spawn.parent_thread_id === "string"
  );
}

export function isArchivedSessionPath(sessionPath: string): boolean {
  return sessionPath.includes(`${sep}archived_sessions${sep}`);
}

export function extractThreadSessionPath(thread: JsonRecord): string | null {
  const pathCandidates = [thread.path, thread.rolloutPath];
  for (const candidate of pathCandidates) {
    const normalized = normalizeNonEmptyString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function arraysReferenceEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

export function extractPathFromCodexFetchBody(body: unknown): string | null {
  if (!isJsonRecord(body)) {
    return null;
  }

  const params = isJsonRecord(body.params) ? body.params : body;
  return typeof params.path === "string" && params.path.trim().length > 0 ? params.path : null;
}

export function extractFetchParams(body: unknown): unknown {
  return isJsonRecord(body) && isJsonRecord(body.params) ? body.params : body;
}

export function extractStringParam(body: unknown, key: string): string | null {
  const params = extractFetchParams(body);
  if (!isJsonRecord(params) || typeof params[key] !== "string") {
    return null;
  }

  const value = params[key].trim();
  return value.length > 0 ? value : null;
}

export function extractResolvedPathParam(body: unknown, key: string): string | null {
  const value = extractStringParam(body, key);
  return value ? resolve(value) : null;
}

export function buildWorktreeConfigStorageKey(root: string, scope: string, key: string): string {
  return `${WORKTREE_CONFIG_VALUE_PREFIX}${scope}:${root}:${key}`;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
