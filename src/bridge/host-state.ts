import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveCodexHomePath } from "../desktop/codex-home.js";
import {
  AUTO_TOP_UP_SETTINGS_KEY,
  CONFIGURATION_STORAGE_PREFIX,
  DEFAULT_OPEN_IN_TARGET,
  MAX_PREVIEW_FILE_BYTES,
  PREFERRED_OPEN_TARGET_KEY,
  type AutoTopUpSettings,
  type LocalEnvironmentDocument,
  type OpenInTarget,
} from "./shared.js";
import {
  buildDefaultLocalEnvironmentConfigPath,
  buildLocalEnvironmentDirectoryPath,
  parseLocalEnvironmentDocument,
} from "./local-environment.js";
import {
  buildWorktreeConfigStorageKey,
  extractFetchParams,
  extractPathFromCodexFetchBody,
  extractResolvedPathParam,
  extractStringParam,
  isJsonRecord,
  isMissingFileError,
  normalizeError,
} from "./utils.js";
import { looksLikeBinaryFile } from "./workspace.js";

const EMBEDDED_MONO_FONT_FAMILY =
  '"FiraCode Nerd Font Mono Embedded", "FiraCode Nerd Font Mono", "Symbols Nerd Font Mono", monospace';

export interface HostStateContext {
  cwd: string;
  globalState: Map<string, unknown>;
  queueGlobalStateRegistryWrite(): void;
  sendLocalRequest(method: string, params?: unknown): Promise<unknown>;
}

export function readGlobalState(
  bridge: HostStateContext,
  body: unknown,
): Record<string, unknown> {
  const key = isJsonRecord(body) && typeof body.key === "string" ? body.key : null;
  if (!key) {
    return {};
  }

  if (bridge.globalState.has(key)) {
    return { value: bridge.globalState.get(key) };
  }

  if (key === "thread-titles") {
    return { value: {} };
  }

  return {};
}

export function readConfiguration(bridge: HostStateContext, body: unknown): { value: unknown } {
  const key = extractStringParam(body, "key");
  return { value: key ? getConfigurationValue(bridge, key) : null };
}

export function writeConfiguration(bridge: HostStateContext, body: unknown): { value: unknown } {
  const key = extractStringParam(body, "key");
  if (!key) {
    return { value: null };
  }

  const params = extractFetchParams(body);
  const value = isJsonRecord(params) ? params.value : undefined;
  setConfigurationValue(bridge, key, value);
  return { value };
}

export function readConfigValue(bridge: HostStateContext, body: unknown): { value: unknown } {
  const params = extractFetchParams(body);
  const root = extractResolvedPathParam(params, "root");
  const key = isJsonRecord(params) && typeof params.key === "string" ? params.key.trim() : "";
  const scope =
    isJsonRecord(params) && typeof params.scope === "string" ? params.scope.trim() : "worktree";
  if (!root || !key) {
    return { value: null };
  }

  return {
    value: bridge.globalState.get(buildWorktreeConfigStorageKey(root, scope, key)) ?? null,
  };
}

export function writeConfigValue(bridge: HostStateContext, body: unknown): Record<string, never> {
  const params = extractFetchParams(body);
  const root = extractResolvedPathParam(params, "root");
  const key = isJsonRecord(params) && typeof params.key === "string" ? params.key.trim() : "";
  const scope =
    isJsonRecord(params) && typeof params.scope === "string" ? params.scope.trim() : "worktree";
  if (!root || !key) {
    return {};
  }

  const storageKey = buildWorktreeConfigStorageKey(root, scope, key);
  const value = isJsonRecord(params) ? params.value : undefined;
  if (value === undefined) {
    bridge.globalState.delete(storageKey);
  } else {
    bridge.globalState.set(storageKey, value);
  }
  bridge.queueGlobalStateRegistryWrite();
  return {};
}

export function readOpenInTargets(bridge: HostStateContext): {
  preferredTarget: string;
  targets: OpenInTarget[];
  availableTargets: OpenInTarget[];
} {
  const stored =
    typeof bridge.globalState.get(PREFERRED_OPEN_TARGET_KEY) === "string"
      ? (bridge.globalState.get(PREFERRED_OPEN_TARGET_KEY) as string)
      : null;
  const preferredTarget = stored || DEFAULT_OPEN_IN_TARGET.id;
  const targets = [DEFAULT_OPEN_IN_TARGET];

  return { preferredTarget, targets, availableTargets: targets };
}

export function writePreferredOpenTarget(
  bridge: HostStateContext,
  body: unknown,
): { target: string } {
  const target = extractStringParam(body, "target") || DEFAULT_OPEN_IN_TARGET.id;
  bridge.globalState.set(PREFERRED_OPEN_TARGET_KEY, target);
  bridge.queueGlobalStateRegistryWrite();
  return { target };
}

export function readTerminalShellOptions(): { availableShells: string[] } {
  if (platform() === "win32") {
    return { availableShells: ["powershell", "cmd"] };
  }
  return { availableShells: [] };
}

export function readAutoTopUpSettings(bridge: HostStateContext): AutoTopUpSettings {
  const stored = bridge.globalState.get(AUTO_TOP_UP_SETTINGS_KEY);
  if (
    isJsonRecord(stored) &&
    typeof stored.is_enabled === "boolean" &&
    ("recharge_threshold" in stored || "recharge_target" in stored)
  ) {
    return {
      is_enabled: stored.is_enabled,
      recharge_threshold:
        typeof stored.recharge_threshold === "number" ? stored.recharge_threshold : null,
      recharge_target: typeof stored.recharge_target === "number" ? stored.recharge_target : null,
    };
  }

  return {
    is_enabled: false,
    recharge_threshold: null,
    recharge_target: null,
  };
}

export function updateAutoTopUpSettings(
  bridge: HostStateContext,
  body: unknown,
  options: { enabled?: boolean; clearThresholds?: boolean } = {},
): AutoTopUpSettings & { immediate_top_up_status: null } {
  const next = readAutoTopUpSettings(bridge);
  const params = extractFetchParams(body);
  if (options.enabled !== undefined) {
    next.is_enabled = options.enabled;
  }
  if (isJsonRecord(params) && typeof params.recharge_threshold === "number") {
    next.recharge_threshold = params.recharge_threshold;
  }
  if (isJsonRecord(params) && typeof params.recharge_target === "number") {
    next.recharge_target = params.recharge_target;
  }
  if (options.clearThresholds) {
    next.recharge_threshold = null;
    next.recharge_target = null;
  }

  bridge.globalState.set(AUTO_TOP_UP_SETTINGS_KEY, next);
  bridge.queueGlobalStateRegistryWrite();

  return { ...next, immediate_top_up_status: null };
}

export async function readCodexConfig(bridge: HostStateContext): Promise<unknown> {
  try {
    return await bridge.sendLocalRequest("config/read", {
      includeLayers: false,
      cwd: bridge.cwd,
    });
  } catch (error) {
    return {
      config: null,
      error: normalizeError(error).message,
    };
  }
}

export async function listLocalEnvironments(
  _bridge: HostStateContext,
  body: unknown,
): Promise<{
  environments: Array<
    | { configPath: string; type: "success"; environment: LocalEnvironmentDocument }
    | { configPath: string; type: "error"; error: { message: string } }
  >;
}> {
  const workspaceRoot = extractResolvedPathParam(extractFetchParams(body), "workspaceRoot");
  if (!workspaceRoot) {
    return { environments: [] };
  }

  const configPaths = await listLocalEnvironmentConfigPaths(workspaceRoot);
  const environments = await Promise.all(
    configPaths.map(async (configPath) => {
      try {
        const raw = await readFile(configPath, "utf8");
        return {
          configPath,
          type: "success" as const,
          environment: parseLocalEnvironmentDocument(raw),
        };
      } catch (error) {
        return {
          configPath,
          type: "error" as const,
          error: { message: normalizeError(error).message },
        };
      }
    }),
  );

  return { environments };
}

export async function readLocalEnvironmentConfig(
  _bridge: HostStateContext,
  body: unknown,
): Promise<{ configPath: string; exists: boolean }> {
  const configPath = await resolveLocalEnvironmentConfigPathFromBody(body);
  return { configPath, exists: existsSync(configPath) };
}

export async function readLocalEnvironment(
  _bridge: HostStateContext,
  body: unknown,
): Promise<{
  environment:
    | { type: "success"; environment: LocalEnvironmentDocument }
    | { type: "error"; error: { message: string } };
}> {
  const configPath = await resolveLocalEnvironmentConfigPathFromBody(body);
  try {
    const raw = await readFile(configPath, "utf8");
    return {
      environment: {
        type: "success",
        environment: parseLocalEnvironmentDocument(raw),
      },
    };
  } catch (error) {
    return {
      environment: {
        type: "error",
        error: { message: normalizeError(error).message },
      },
    };
  }
}

export async function writeLocalEnvironmentConfig(
  _bridge: HostStateContext,
  body: unknown,
): Promise<{ configPath: string }> {
  const params = extractFetchParams(body);
  const configPath =
    isJsonRecord(params) && typeof params.configPath === "string"
      ? resolve(params.configPath)
      : "";
  const raw = isJsonRecord(params) && typeof params.raw === "string" ? params.raw : null;
  if (!configPath || raw === null) {
    throw new Error("Local environment configPath and raw contents are required.");
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, raw, "utf8");
  return { configPath };
}

export function readDeveloperInstructions(body: unknown): string | null {
  if (!isJsonRecord(body)) {
    return null;
  }
  const params = isJsonRecord(body.params) ? body.params : body;
  return typeof params.baseInstructions === "string" ? params.baseInstructions : null;
}

export function getCodexHomePath(): string {
  return resolveCodexHomePath();
}

export async function readCodexAgentsDocument(): Promise<{ path: string; contents: string }> {
  const documentPath = join(getCodexHomePath(), "AGENTS.md");
  let stats;
  try {
    stats = await stat(documentPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { path: documentPath, contents: "" };
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error(`AGENTS.md path is not a file: ${documentPath}`);
  }
  if (stats.size > MAX_PREVIEW_FILE_BYTES) {
    throw new Error(`AGENTS.md is too large to load: ${documentPath}`);
  }

  const contents = await readFile(documentPath);
  if (looksLikeBinaryFile(contents)) {
    throw new Error(`AGENTS.md is binary and cannot be loaded: ${documentPath}`);
  }

  return { path: documentPath, contents: contents.toString("utf8") };
}

export async function writeCodexAgentsDocument(body: unknown): Promise<{ path: string }> {
  const params = isJsonRecord(body) && isJsonRecord(body.params) ? body.params : body;
  const contents =
    isJsonRecord(params) && typeof params.contents === "string" ? params.contents : null;
  if (contents === null) {
    throw new Error("AGENTS.md contents are required.");
  }

  const documentPath = join(getCodexHomePath(), "AGENTS.md");
  await mkdir(dirname(documentPath), { recursive: true });
  await writeFile(documentPath, contents, "utf8");
  return { path: documentPath };
}

export async function readFileBinary(body: unknown): Promise<{ contentsBase64: string }> {
  const path = extractPathFromCodexFetchBody(body);
  if (!path) {
    throw new Error("File path is required.");
  }

  const resolvedPath = resolve(path);
  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch {
    throw new Error(`File path does not exist: ${resolvedPath}`);
  }

  if (!stats.isFile()) {
    throw new Error(`File path is not a file: ${resolvedPath}`);
  }

  const contents = await readFile(resolvedPath);
  return { contentsBase64: contents.toString("base64") };
}

export async function readFileText(body: unknown): Promise<{ contents: string }> {
  const path = extractPathFromCodexFetchBody(body);
  if (!path) {
    throw new Error("File path is required.");
  }

  const resolvedPath = resolve(path);
  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch {
    throw new Error(`File path does not exist: ${resolvedPath}`);
  }

  if (!stats.isFile()) {
    throw new Error(`File path is not a file: ${resolvedPath}`);
  }
  if (stats.size > MAX_PREVIEW_FILE_BYTES) {
    throw new Error(`File is too large to preview: ${resolvedPath}`);
  }

  const contents = await readFile(resolvedPath);
  if (looksLikeBinaryFile(contents)) {
    throw new Error(`File is binary and cannot be previewed: ${resolvedPath}`);
  }

  return { contents: contents.toString("utf8") };
}

export function listExistingPaths(body: unknown): string[] {
  if (!isJsonRecord(body) || !Array.isArray(body.paths)) {
    return [];
  }

  return body.paths.filter(
    (value): value is string => typeof value === "string" && value.length > 0 && existsSync(value),
  );
}

function getConfigurationValue(bridge: HostStateContext, key: string): unknown {
  if (key === "appearanceTheme" && bridge.globalState.has("appearanceTheme")) {
    return bridge.globalState.get("appearanceTheme");
  }

  const storedKey = `${CONFIGURATION_STORAGE_PREFIX}${key}`;
  if (bridge.globalState.has(storedKey)) {
    return bridge.globalState.get(storedKey);
  }

  switch (key) {
    case "appearanceTheme":
      return "system";
    case "usePointerCursors":
      return false;
    case "sansFontSize":
      return 13;
    case "codeFontFamily":
      return EMBEDDED_MONO_FONT_FAMILY;
    case "codeFontSize":
      return 12;
    case "localeOverride":
      return null;
    case "preventSleepWhileRunning":
      return false;
    case "runCodexInWsl":
      return false;
    case "integratedTerminalShell":
      return platform() === "win32" ? "powershell" : null;
    case "conversationDetailMode":
      return "STEPS_COMMANDS";
    default:
      return null;
  }
}

function setConfigurationValue(bridge: HostStateContext, key: string, value: unknown): void {
  bridge.globalState.set(`${CONFIGURATION_STORAGE_PREFIX}${key}`, value ?? null);
  if (key === "appearanceTheme") {
    bridge.globalState.set("appearanceTheme", value ?? "system");
  }
  bridge.queueGlobalStateRegistryWrite();
}

async function resolveLocalEnvironmentConfigPathFromBody(body: unknown): Promise<string> {
  const params = extractFetchParams(body);
  const configPath =
    isJsonRecord(params) && typeof params.configPath === "string" ? params.configPath.trim() : "";
  if (configPath) {
    return resolve(configPath);
  }

  const workspaceRoot = extractResolvedPathParam(params, "workspaceRoot");
  if (!workspaceRoot) {
    throw new Error("Local environment configPath is required.");
  }

  return buildDefaultLocalEnvironmentConfigPath(workspaceRoot);
}

async function listLocalEnvironmentConfigPaths(workspaceRoot: string): Promise<string[]> {
  const environmentsDirectory = buildLocalEnvironmentDirectoryPath(workspaceRoot);
  let entries;
  try {
    entries = await readdir(environmentsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => join(environmentsDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}
