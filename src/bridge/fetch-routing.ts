import { arch, platform } from "node:os";
import { basename, extname } from "node:path";

import { resolveCodexHomePath } from "../desktop/codex-home.js";
import { resolveGitOrigins } from "./git.js";
import type { AppServerFetchRequest, AutoTopUpSettings } from "./shared.js";
import {
  listExistingPaths,
  listLocalEnvironments,
  readAutoTopUpSettings,
  readCodexAgentsDocument,
  readCodexConfig,
  readConfiguration,
  readDeveloperInstructions,
  readFileBinary,
  readFileText,
  readGlobalState,
  readLocalEnvironment,
  readLocalEnvironmentConfig,
  readOpenInTargets,
  readTerminalShellOptions,
  updateAutoTopUpSettings,
  writeCodexAgentsDocument,
  writeConfigValue,
  writeConfiguration,
  writeLocalEnvironmentConfig,
  writePreferredOpenTarget,
  type HostStateContext,
} from "./host-state.js";
import {
  execFileText,
  normalizeError,
  normalizeHeaders,
  normalizeRequestBody,
  parseJsonBody,
  parseResponseBody,
} from "./utils.js";

export interface FetchRoutingContext extends HostStateContext {
  fetchRequests: Map<string, AbortController>;
  handleIpcRequest(payload: unknown): Promise<unknown>;
  getActiveWorkspaceRoots(): string[];
  workspaceRoots: Set<string>;
  workspaceRootLabels: Map<string, string>;
  pinnedThreadIds: Set<string>;
  writeGlobalState(body: unknown): Record<string, never>;
  setThreadPinned(body: unknown): Record<string, never>;
  setPinnedThreadsOrder(body: unknown): Record<string, never>;
  addWorkspaceRootOption(body: unknown): Promise<{ success: boolean; root: string }>;
  readConfigValue(body: unknown): { value: unknown };
  readLocalEnvironmentConfig(body: unknown): Promise<{ configPath: string; exists: boolean }>;
  readLocalEnvironment(body: unknown): Promise<{
    environment:
      | { type: "success"; environment: unknown }
      | { type: "error"; error: { message: string } };
  }>;
  writeLocalEnvironmentConfig(body: unknown): Promise<{ configPath: string }>;
  readOpenInTargets(): {
    preferredTarget: string;
    targets: Array<{ id: string; label: string; icon: string | null; available: boolean; default?: boolean }>;
    availableTargets: Array<{ id: string; label: string; icon: string | null; available: boolean; default?: boolean }>;
  };
  writePreferredOpenTarget(body: unknown): { target: string };
  readTerminalShellOptions(): { availableShells: string[] };
  readAutoTopUpSettings(): AutoTopUpSettings;
  updateAutoTopUpSettings(
    body: unknown,
    options?: { enabled?: boolean; clearThresholds?: boolean },
  ): AutoTopUpSettings & { immediate_top_up_status: null };
  getGitOriginFallbackDirectories(): string[];
  emitBridgeMessage(message: { type: string; [key: string]: unknown }): void;
  emitFetchSuccess(requestId: string, body: unknown, status?: number): void;
  emitFetchError(requestId: string, status: number, error: string): void;
}

export async function handleFetchRequest(
  bridge: FetchRoutingContext,
  message: AppServerFetchRequest,
): Promise<void> {
  if (!message.requestId || !message.url) {
    return;
  }

  const controller = new AbortController();
  bridge.fetchRequests.set(message.requestId, controller);

  try {
    if (message.url === "vscode://codex/ipc-request") {
      const payload = parseJsonBody(message.body);
      const result = await bridge.handleIpcRequest(payload);
      bridge.emitFetchSuccess(message.requestId, result);
      return;
    }

    if (message.url.startsWith("vscode://codex/")) {
      const body = parseJsonBody(message.body);
      const handled = await handleCodexFetchRequest(bridge, message.url, body);
      if (handled) {
        bridge.emitFetchSuccess(message.requestId, handled.body, handled.status);
        return;
      }
      bridge.emitFetchError(message.requestId, 501, `Unsupported Codex host fetch URL: ${message.url}`);
      return;
    }

    if (message.url.startsWith("/")) {
      const handled = await handleRelativeFetchRequest(bridge, message.url, parseJsonBody(message.body));
      if (handled) {
        bridge.emitFetchSuccess(message.requestId, handled.body, handled.status);
        return;
      }

      const response = await fetch(new URL(message.url, "https://chatgpt.com"), {
        method: typeof message.method === "string" ? message.method : "GET",
        headers: normalizeHeaders(message.headers),
        body: normalizeRequestBody(message.body),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      bridge.emitBridgeMessage({
        type: "fetch-response",
        requestId: message.requestId,
        responseType: "success",
        status: response.status,
        headers,
        bodyJsonString: JSON.stringify(parseResponseBody(bodyText)),
      });
      return;
    }

    const response = await fetch(message.url, {
      method: typeof message.method === "string" ? message.method : "GET",
      headers: normalizeHeaders(message.headers),
      body: normalizeRequestBody(message.body),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    bridge.emitBridgeMessage({
      type: "fetch-response",
      requestId: message.requestId,
      responseType: "success",
      status: response.status,
      headers,
      bodyJsonString: JSON.stringify(parseResponseBody(bodyText)),
    });
  } catch (error) {
    const normalized = normalizeError(error);
    bridge.emitFetchError(message.requestId, 500, normalized.message);
  } finally {
    bridge.fetchRequests.delete(message.requestId);
  }
}

export function handleFetchCancel(bridge: FetchRoutingContext, requestId: string): void {
  bridge.fetchRequests.get(requestId)?.abort();
  bridge.fetchRequests.delete(requestId);
}

export async function handleCodexFetchRequest(
  bridge: FetchRoutingContext,
  rawUrl: string,
  body: unknown,
): Promise<{ status: number; body: unknown } | null> {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/^\/+/, "");

  switch (path) {
    case "get-global-state":
      return { status: 200, body: readGlobalState(bridge, body) };
    case "codex-agents-md":
      return { status: 200, body: await readCodexAgentsDocument() };
    case "codex-agents-md-save":
      return { status: 200, body: await writeCodexAgentsDocument(body) };
    case "set-global-state":
      return { status: 200, body: bridge.writeGlobalState(body) };
    case "list-pinned-threads":
      return { status: 200, body: { threadIds: Array.from(bridge.pinnedThreadIds) } };
    case "set-thread-pinned":
      return { status: 200, body: bridge.setThreadPinned(body) };
    case "set-pinned-threads-order":
      return { status: 200, body: bridge.setPinnedThreadsOrder(body) };
    case "active-workspace-roots":
      return { status: 200, body: { roots: bridge.getActiveWorkspaceRoots() } };
    case "workspace-root-options":
      return {
        status: 200,
        body: { roots: Array.from(bridge.workspaceRoots), labels: Object.fromEntries(bridge.workspaceRootLabels) },
      };
    case "add-workspace-root-option":
      return { status: 200, body: await bridge.addWorkspaceRootOption(body) };
    case "list-pending-automation-run-threads":
      return { status: 200, body: { threadIds: [] } };
    case "extension-info":
      return { status: 200, body: { version: "0.1.0", buildFlavor: "picodex", buildNumber: "0" } };
    case "is-copilot-api-available":
      return { status: 200, body: { available: false } };
    case "get-copilot-api-proxy-info":
      return { status: 200, body: {} };
    case "mcp-codex-config":
      return { status: 200, body: await readCodexConfig(bridge) };
    case "config-value":
      return { status: 200, body: bridge.readConfigValue(body) };
    case "set-config-value":
      return { status: 200, body: writeConfigValue(bridge, body) };
    case "developer-instructions":
      return { status: 200, body: { instructions: readDeveloperInstructions(body) } };
    case "os-info":
      return { status: 200, body: { platform: platform(), arch: arch(), hasWsl: false } };
    case "local-environments":
      return { status: 200, body: await listLocalEnvironments(bridge, body) };
    case "codex-home":
      return { status: 200, body: { codexHome: resolveCodexHomePath() } };
    case "list-automations":
      return { status: 200, body: { items: [] } };
    case "recommended-skills":
      return { status: 200, body: { skills: [] } };
    case "fast-mode-rollout-metrics":
      return { status: 200, body: { estimatedSavedMs: 0, rolloutCountWithCompletedTurns: 0 } };
    case "has-custom-cli-executable":
      return { status: 200, body: { hasCustomCliExecutable: false } };
    case "locale-info":
      return {
        status: 200,
        body: { ideLocale: "en-US", systemLocale: Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US" },
      };
    case "inbox-items":
      return { status: 200, body: { items: [] } };
    case "open-in-targets":
      return { status: 200, body: bridge.readOpenInTargets() };
    case "set-preferred-app":
      return { status: 200, body: bridge.writePreferredOpenTarget(body) };
    case "gh-cli-status":
      return { status: 200, body: { isInstalled: false, isAuthenticated: false } };
    case "gh-pr-status":
      return {
        status: 200,
        body: {
          status: "unavailable",
          hasOpenPr: false,
          isDraft: false,
          canMerge: false,
          ciStatus: null,
          url: null,
        },
      };
    case "ide-context":
      return { status: 200, body: { ideContext: null } };
    case "paths-exist":
      return { status: 200, body: { existingPaths: listExistingPaths(body) } };
    case "read-file-binary":
      return { status: 200, body: await readFileBinary(body) };
    case "read-file":
      return { status: 200, body: await readFileText(body) };
    case "account-info":
      return { status: 200, body: { accountId: null, plan: null } };
    case "get-configuration":
      return { status: 200, body: readConfiguration(bridge, body) };
    case "set-configuration":
      return { status: 200, body: writeConfiguration(bridge, body) };
    case "terminal-shell-options":
      return { status: 200, body: bridge.readTerminalShellOptions() };
    case "local-environment-config":
      return { status: 200, body: await bridge.readLocalEnvironmentConfig(body) };
    case "local-environment":
      return { status: 200, body: await bridge.readLocalEnvironment(body) };
    case "local-environment-config-save":
      return { status: 200, body: await bridge.writeLocalEnvironmentConfig(body) };
    case "hotkey-window-hotkey-state":
      return {
        status: 200,
        body: {
          supported: false,
          isDevMode: false,
          isGateEnabled: false,
          isActive: false,
          isDevOverrideEnabled: false,
          configuredHotkey: null,
        },
      };
    case "git-origins":
      return { status: 200, body: await resolveGitOrigins(body, bridge.getGitOriginFallbackDirectories()) };
    case "generate-commit-message":
      return { status: 200, body: { message: await generateCommitMessage(body) } };
    default:
      return null;
  }
}

export async function handleRelativeFetchRequest(
  bridge: FetchRoutingContext,
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown } | null> {
  if (url === "/payments/customer_portal") {
    return { status: 200, body: { url: "https://platform.openai.com/settings/organization/billing/overview" } };
  }
  if (url.startsWith("/accounts/check/")) {
    return { status: 200, body: { accounts: {}, account_ordering: [] } };
  }
  if (url.startsWith("/checkout_pricing_config/configs/")) {
    const currencyCode = decodeURIComponent(url.split("/").at(-1) || "USD").toUpperCase();
    return {
      status: 200,
      body: { currency_config: { amount_per_credit: 1, symbol_code: currencyCode, minor_unit_exponent: 2 } },
    };
  }
  if (url === "/subscriptions/auto_top_up/settings") {
    return { status: 200, body: bridge.readAutoTopUpSettings() };
  }
  if (url === "/subscriptions/auto_top_up/enable") {
    return { status: 200, body: bridge.updateAutoTopUpSettings(body, { enabled: true }) };
  }
  if (url === "/subscriptions/auto_top_up/update") {
    return { status: 200, body: bridge.updateAutoTopUpSettings(body) };
  }
  if (url === "/subscriptions/auto_top_up/disable") {
    return {
      status: 200,
      body: bridge.updateAutoTopUpSettings(body, { enabled: false, clearThresholds: true }),
    };
  }
  if (url === "/wham/accounts/check") {
    return { status: 200, body: { accounts: [], account_ordering: [] } };
  }
  if (url === "/wham/environments") {
    return { status: 200, body: [] };
  }
  if (url === "/wham/usage") {
    return { status: 200, body: { credits: null, plan_type: null, rate_limit: null } };
  }
  if (url.startsWith("/wham/tasks/list")) {
    return { status: 200, body: { items: [], tasks: [], nextCursor: null } };
  }
  return null;
}

interface GitStatusEntry {
  path: string;
  kind: "added" | "deleted" | "renamed" | "modified";
}

async function generateCommitMessage(body: unknown): Promise<string | null> {
  const cwd = readNonEmptyString(body, "cwd");
  const prompt = readNonEmptyString(body, "prompt");

  if (cwd) {
    const fromGit = await generateCommitMessageFromGit(cwd);
    if (fromGit) {
      return fromGit;
    }
  }

  return generateCommitMessageFromPrompt(prompt);
}

async function generateCommitMessageFromGit(cwd: string): Promise<string | null> {
  try {
    await execFileText("git", ["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return null;
  }

  const entries = await readGitStatusEntries(cwd);
  if (entries.length === 0) {
    return null;
  }

  const scope = inferCommitScope(entries.map((entry) => entry.path));
  const verb = inferCommitVerb(entries);
  if (entries.length === 1) {
    return `${verb} ${describeSinglePath(entries[0].path)}`;
  }
  if (scope) {
    return `${verb} ${scope}`;
  }
  return `${verb} project files`;
}

async function readGitStatusEntries(cwd: string): Promise<GitStatusEntry[]> {
  try {
    const output = await execFileText("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd);
    if (!output) {
      return [];
    }

    return output
      .split("\n")
      .map((line) => parseGitStatusEntry(line))
      .filter((entry): entry is GitStatusEntry => entry !== null);
  } catch {
    return [];
  }
}

function parseGitStatusEntry(line: string): GitStatusEntry | null {
  if (line.startsWith("?? ")) {
    return {
      path: line.slice(3).trim(),
      kind: "added",
    };
  }

  if (line.length < 4) {
    return null;
  }

  const status = `${line[0]}${line[1]}`;
  const rawPath = line.slice(3).trim();
  if (!rawPath) {
    return null;
  }

  const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)?.trim() ?? rawPath : rawPath;
  if (!path) {
    return null;
  }

  if (status.includes("R") || rawPath.includes(" -> ")) {
    return { path, kind: "renamed" };
  }
  if (status.includes("D")) {
    return { path, kind: "deleted" };
  }
  if (status.includes("A")) {
    return { path, kind: "added" };
  }
  return { path, kind: "modified" };
}

function inferCommitVerb(entries: GitStatusEntry[]): "Add" | "Remove" | "Rename" | "Update" {
  const kinds = new Set(entries.map((entry) => entry.kind));
  if (kinds.size === 1) {
    const [kind] = kinds;
    if (kind === "added") {
      return "Add";
    }
    if (kind === "deleted") {
      return "Remove";
    }
    if (kind === "renamed") {
      return "Rename";
    }
  }

  const paths = entries.map((entry) => entry.path);
  if (paths.every((path) => isDocumentationPath(path))) {
    return "Update";
  }

  return "Update";
}

function inferCommitScope(paths: string[]): string | null {
  if (paths.length === 0) {
    return null;
  }

  if (paths.every((path) => isDocumentationPath(path))) {
    return "docs";
  }

  const topLevelSegments = paths
    .map((path) => normalizePathSegments(path))
    .filter((segments) => segments.length > 0)
    .map((segments) => segments[0]);
  if (topLevelSegments.length === 0) {
    return null;
  }

  const uniqueTopLevelSegments = [...new Set(topLevelSegments)];
  if (uniqueTopLevelSegments.length === 1) {
    return describeSegment(uniqueTopLevelSegments[0]);
  }

  return null;
}

function describeSinglePath(path: string): string {
  const segments = normalizePathSegments(path);
  if (segments.length === 0) {
    return "files";
  }

  if (isDocumentationPath(path)) {
    return "docs";
  }

  const stem = basename(path, extname(path));
  const humanizedStem = humanizeToken(stem);
  if (segments[0] === "src" && segments.length >= 3) {
    const scope = describeSegment(segments[1]);
    if (!humanizedStem.includes(scope)) {
      return `${scope} ${humanizedStem}`;
    }
  }

  if (stem === "package" && path.endsWith("package.json")) {
    return "package metadata";
  }
  if (path.endsWith("tsconfig.json")) {
    return "TypeScript config";
  }

  return humanizedStem;
}

function generateCommitMessageFromPrompt(prompt: string | null): string | null {
  if (!prompt) {
    return null;
  }

  const matches = [...prompt.matchAll(/(?:^|[\s`'"])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?=$|[\s`'"])/gm)]
    .map((match) => match[1])
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  if (matches.length === 0) {
    return "Update project files";
  }

  const scope = inferCommitScope(matches);
  if (matches.length === 1) {
    return `Update ${describeSinglePath(matches[0])}`;
  }
  if (scope) {
    return `Update ${scope}`;
  }
  return "Update project files";
}

function normalizePathSegments(path: string): string[] {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function describeSegment(segment: string): string {
  if (segment === "src") {
    return "source";
  }
  if (segment === "assets") {
    return "assets";
  }
  if (segment === "docs") {
    return "docs";
  }
  return humanizeToken(segment);
}

function humanizeToken(value: string): string {
  return value.replaceAll(/[-_]+/g, " ").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function isDocumentationPath(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  return normalizedPath.startsWith("docs/") || normalizedPath.endsWith("/readme.md") || normalizedPath === "readme.md";
}

function readNonEmptyString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}
