import { createInterface } from "node:readline";

import { loadGlobalStateRegistry } from "../state/global-state-registry.js";
import { loadPersistedAtomRegistry } from "../state/persisted-atom-registry.js";
import { debugLog, warnOnceLog } from "../core/debug.js";
import { loadWorkspaceRootRegistry } from "../state/workspace-root-registry.js";
import {
  DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT,
  MAX_THREAD_LIST_SUBAGENT_READS,
  type AppServerBridgeOptions,
  type PendingLocalRequest,
} from "./shared.js";
import {
  buildIpcErrorResponse,
  buildIpcSuccessResponse,
  isJsonRecord,
  normalizeError,
  normalizeExperimentalFeatureEnablementMap,
  normalizePositiveInteger,
  parseExperimentalFeatureCursor,
} from "./utils.js";

export interface LifecycleContext {
  hostId: string;
  child: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; stdin: NodeJS.WritableStream; once: any; on: any };
  gitWorkerBridge: { on: any };
  codexDesktopGlobalStatePath: string;
  persistedAtomRegistryPath: string;
  globalStateRegistryPath: string;
  workspaceRootRegistryPath: string;
  cwd: string;
  localRequests: Map<string, PendingLocalRequest>;
  pendingRemoteRequestMethods: Map<string, string>;
  pendingRemoteRequestParams: Map<string, unknown>;
  persistedAtoms: Map<string, unknown>;
  globalState: Map<string, unknown>;
  pinnedThreadIds: Set<string>;
  isClosing: boolean;
  isInitialized: boolean;
  connectionState: "connecting" | "connected" | "disconnected";
  desktopImportPromptSeen: boolean;
  reserveLocalRequestId(): string;
  setIsInitialized(next: boolean): void;
  setConnectionState(next: "connecting" | "connected" | "disconnected"): void;
  setDesktopImportPromptSeen(next: boolean): void;
  emit(event: "worker_message" | "bridge_message" | "error", ...args: unknown[]): boolean;
  emitConnectionState(): void;
  handleStdoutLine(line: string): Promise<void>;
  applyWorkspaceRootRegistry(state: unknown): void;
  syncWorkspaceGlobalState(): void;
  sendJsonRpcMessage(message: Record<string, unknown>): void;
  handleIpcRequest(payload: unknown): Promise<unknown>;
  listDesktopWorkspaceImportCandidates(): Promise<unknown>;
  applyDesktopWorkspaceImports(params: unknown): Promise<unknown>;
  addManualWorkspaceRoot(params: unknown): Promise<unknown>;
  pickDesktopWorkspaceDirectory(params: unknown): Promise<unknown>;
  dismissDesktopWorkspaceImportPrompt(): Promise<unknown>;
  handleFuzzyFileSearch(params: unknown): Promise<unknown>;
  startFuzzyFileSearchSession(params: unknown): Promise<unknown>;
  updateFuzzyFileSearchSession(params: unknown): Promise<unknown>;
  stopFuzzyFileSearchSession(params: unknown): Promise<unknown>;
  resolveHostFiles(params: unknown): Promise<unknown>;
  listHostDirectory(params: unknown): Promise<unknown>;
  listWorkspaceFileRoots(): Promise<unknown>;
  listWorkspaceDirectory(params: unknown): Promise<unknown>;
  readWorkspaceFile(params: unknown): Promise<unknown>;
  highlightWorkspaceFile(params: unknown): Promise<unknown>;
  searchWorkspaceBrowserFiles(params: unknown): Promise<unknown>;
  handleLocalJsonRpcRequest(method: string, params: unknown): Promise<{ handled: true; result: unknown } | { handled: false }>;
  listExperimentalFeatures(params: unknown): { data: Array<{ name: string; enabled: boolean }>; nextCursor: string | null };
  setExperimentalFeatureEnablement(params: unknown): { name: string; featureName: string; enabled: boolean };
  getExperimentalFeatureEnablement(): Record<string, boolean>;
  queueGlobalStateRegistryWrite(): void;
}

export async function handleIpcRequest(bridge: LifecycleContext, payload: unknown): Promise<unknown> {
  if (!isJsonRecord(payload)) {
    return buildIpcErrorResponse("", "Invalid IPC request payload.");
  }

  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  const method = typeof payload.method === "string" ? payload.method : "";
  if (!method) {
    return buildIpcErrorResponse(requestId, "Missing IPC method.");
  }

  try {
    switch (method) {
      case "app-server/request":
        return buildIpcSuccessResponse(
          requestId,
          await handleAllowedAppServerIpcRequest(bridge, payload.params),
        );
      case "desktop-workspace-import/list":
        return buildIpcSuccessResponse(requestId, await bridge.listDesktopWorkspaceImportCandidates());
      case "desktop-workspace-import/apply":
        return buildIpcSuccessResponse(requestId, await bridge.applyDesktopWorkspaceImports(payload.params));
      case "desktop-workspace-import/add-manual":
        return buildIpcSuccessResponse(requestId, await bridge.addManualWorkspaceRoot(payload.params));
      case "desktop-workspace-import/pick-directory":
        return buildIpcSuccessResponse(requestId, await bridge.pickDesktopWorkspaceDirectory(payload.params));
      case "desktop-workspace-import/dismiss":
        return buildIpcSuccessResponse(requestId, await bridge.dismissDesktopWorkspaceImportPrompt());
      case "fuzzyFileSearch":
        return buildIpcSuccessResponse(requestId, await bridge.handleFuzzyFileSearch(payload.params));
      case "fuzzyFileSearch/sessionStart":
        return buildIpcSuccessResponse(requestId, await bridge.startFuzzyFileSearchSession(payload.params));
      case "fuzzyFileSearch/sessionUpdate":
        return buildIpcSuccessResponse(requestId, await bridge.updateFuzzyFileSearchSession(payload.params));
      case "fuzzyFileSearch/sessionStop":
        return buildIpcSuccessResponse(requestId, await bridge.stopFuzzyFileSearchSession(payload.params));
      case "host-files/resolve":
        return buildIpcSuccessResponse(requestId, await bridge.resolveHostFiles(payload.params));
      case "host-files/list-directory":
        return buildIpcSuccessResponse(requestId, await bridge.listHostDirectory(payload.params));
      case "workspace-files/list-roots":
        return buildIpcSuccessResponse(requestId, await bridge.listWorkspaceFileRoots());
      case "workspace-files/list-directory":
        return buildIpcSuccessResponse(requestId, await bridge.listWorkspaceDirectory(payload.params));
      case "workspace-files/read":
        return buildIpcSuccessResponse(requestId, await bridge.readWorkspaceFile(payload.params));
      case "workspace-files/highlight":
        return buildIpcSuccessResponse(requestId, await bridge.highlightWorkspaceFile(payload.params));
      case "workspace-files/search":
        return buildIpcSuccessResponse(requestId, await bridge.searchWorkspaceBrowserFiles(payload.params));
      default:
        return buildIpcErrorResponse(requestId, `IPC method "${method}" is not supported in Picodex yet.`);
    }
  } catch (error) {
    return buildIpcErrorResponse(requestId, error instanceof Error ? error.message : String(error));
  }
}

const ALLOWED_BROWSER_APP_SERVER_IPC_METHODS = new Set([
  "config/batchWrite",
  "config/read",
  "config/value/write",
  "model/list",
]);

async function handleAllowedAppServerIpcRequest(
  bridge: LifecycleContext,
  params: unknown,
): Promise<unknown> {
  if (!isJsonRecord(params)) {
    throw new Error("Invalid app-server IPC params.");
  }

  const requestedMethod =
    typeof params.method === "string" ? params.method.trim() : "";
  if (!requestedMethod) {
    throw new Error("Missing app-server request method.");
  }

  if (!ALLOWED_BROWSER_APP_SERVER_IPC_METHODS.has(requestedMethod)) {
    throw new Error(`App-server request "${requestedMethod}" is not allowed from browser IPC.`);
  }

  const requestedParams = "params" in params ? params.params : undefined;
  return sendLocalRequest(bridge, requestedMethod, requestedParams);
}

export function bindProcess(bridge: LifecycleContext): void {
  const stdout = createInterface({ input: bridge.child.stdout });
  stdout.on("line", (line) => {
    void bridge.handleStdoutLine(line);
  });

  const stderr = createInterface({ input: bridge.child.stderr });
  stderr.on("line", (line) => {
    debugLog("app-server", "stderr", line);
  });

  bridge.child.on("error", (error: Error) => {
    bridge.setConnectionState("disconnected");
    rejectPendingRequests(bridge, error);
    bridge.emit("error", error);
  });

  bridge.child.once("exit", (code: number | null, signal: string | null) => {
    bridge.setConnectionState("disconnected");
    rejectPendingRequests(
      bridge,
      new Error(`Codex app-server exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`),
    );
    bridge.emitConnectionState();

    if (bridge.isClosing) {
      return;
    }

    const error = new Error("Codex app-server exited unexpectedly.");
    bridge.emit("bridge_message", {
      type: "codex-app-server-fatal-error",
      hostId: bridge.hostId,
      message: error.message,
    });
    bridge.emit("error", error);
  });
}

export function bindGitWorker(bridge: LifecycleContext): void {
  bridge.gitWorkerBridge.on("message", (message: unknown) => {
    bridge.emit("worker_message", "git", message);
  });

  bridge.gitWorkerBridge.on("error", (error: Error) => {
    debugLog("git-worker", "desktop git worker bridge error", { error: error.message });
    bridge.emit("error", error);
  });
}

export async function initialize(bridge: LifecycleContext): Promise<void> {
  debugLog("app-server", "starting initialize handshake", { hostId: bridge.hostId });

  await sendLocalRequest(bridge, "initialize", {
    clientInfo: {
      name: "picodex",
      title: "Picodex",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  bridge.sendJsonRpcMessage({ method: "initialized" });

  bridge.setIsInitialized(true);
  bridge.setConnectionState("connected");
}

export async function restoreWorkspaceRootRegistry(bridge: LifecycleContext): Promise<void> {
  try {
    const loaded = await loadWorkspaceRootRegistry(bridge.workspaceRootRegistryPath);
    if (loaded.state) {
      bridge.setDesktopImportPromptSeen(loaded.state.desktopImportPromptSeen);
      bridge.applyWorkspaceRootRegistry(loaded.state);
    }
  } catch (error) {
    debugLog("app-server", "failed to restore workspace root registry", {
      error: normalizeError(error).message,
      path: bridge.workspaceRootRegistryPath,
    });
  }

  bridge.syncWorkspaceGlobalState();
}

export async function restorePersistedAtomRegistry(bridge: LifecycleContext): Promise<void> {
  try {
    const loaded = await loadPersistedAtomRegistry(bridge.persistedAtomRegistryPath);
    bridge.persistedAtoms.clear();
    for (const [key, value] of Object.entries(loaded.state)) {
      bridge.persistedAtoms.set(key, value);
    }
  } catch (error) {
    debugLog("app-server", "failed to restore persisted atoms", {
      error: normalizeError(error).message,
      path: bridge.persistedAtomRegistryPath,
    });
  }
}

export async function restoreGlobalStateRegistry(bridge: LifecycleContext): Promise<void> {
  try {
    const loaded = await loadGlobalStateRegistry(bridge.globalStateRegistryPath);
    bridge.globalState.clear();
    for (const [key, value] of Object.entries(loaded.state)) {
      bridge.globalState.set(key, value);
    }

    const pinnedThreadIds = bridge.globalState.get("pinned-thread-ids");
    bridge.pinnedThreadIds.clear();
    if (Array.isArray(pinnedThreadIds)) {
      for (const value of pinnedThreadIds) {
        if (typeof value === "string") {
          bridge.pinnedThreadIds.add(value);
        }
      }
    }
  } catch (error) {
    debugLog("app-server", "failed to restore global state", {
      error: normalizeError(error).message,
      path: bridge.globalStateRegistryPath,
    });
  }

  bridge.syncWorkspaceGlobalState();
}

export async function handleLocalJsonRpcRequest(
  bridge: LifecycleContext,
  method: string,
  params: unknown,
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (method) {
    case "experimentalFeature/list":
      return { handled: true, result: listExperimentalFeatures(bridge, params) };
    case "experimentalFeature/enablement/set":
      return { handled: true, result: setExperimentalFeatureEnablement(bridge, params) };
    default:
      return { handled: false };
  }
}

export function listExperimentalFeatures(bridge: LifecycleContext, params: unknown): {
  data: Array<{ name: string; enabled: boolean }>;
  nextCursor: string | null;
} {
  const requestedCursor = isJsonRecord(params) && typeof params.cursor === "string" ? params.cursor : null;
  const startIndex = parseExperimentalFeatureCursor(requestedCursor);
  const requestedLimit = isJsonRecord(params) ? normalizePositiveInteger(params.limit) : null;
  const featureEntries = Object.entries(getExperimentalFeatureEnablement(bridge)).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const limit = requestedLimit ?? (featureEntries.length || 100);
  const data = featureEntries.slice(startIndex, startIndex + limit).map(([name, enabled]) => ({ name, enabled }));
  const nextCursor = startIndex + data.length < featureEntries.length ? String(startIndex + data.length) : null;

  debugLog("app-server", "served experimental feature list", {
    requestedCursor,
    nextCursor,
    limit,
    totalFeatureCount: featureEntries.length,
    features: data,
  });

  return { data, nextCursor };
}

export function setExperimentalFeatureEnablement(
  bridge: LifecycleContext,
  params: unknown,
): { name: string; featureName: string; enabled: boolean } {
  const featureName =
    isJsonRecord(params) && typeof params.featureName === "string" ? params.featureName.trim() : "";
  if (featureName.length === 0) {
    throw new Error("Missing experimental feature name.");
  }

  const enabled = isJsonRecord(params) && typeof params.enabled === "boolean" ? params.enabled : false;
  const features = getExperimentalFeatureEnablement(bridge);
  const wasKnown =
    Object.prototype.hasOwnProperty.call(DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT, featureName) ||
    featureName in features;
  features[featureName] = enabled;
  bridge.globalState.set("experimental-features", features);
  bridge.queueGlobalStateRegistryWrite();

  if (!wasKnown) {
    warnOnceLog(
      "app-server",
      `experimental-feature-discovered:${featureName}`,
      "discovered new experimental feature name",
      { featureName, enabled },
    );
  }

  debugLog("app-server", "updated experimental feature enablement", { featureName, enabled });
  return { name: featureName, featureName, enabled };
}

export function getExperimentalFeatureEnablement(bridge: LifecycleContext): Record<string, boolean> {
  return {
    ...DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT,
    ...normalizeExperimentalFeatureEnablementMap(bridge.globalState.get("experimental-features")),
  };
}

export async function sendLocalRequest(
  bridge: LifecycleContext,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const localResult = await handleLocalJsonRpcRequest(bridge, method, params);
  if (localResult.handled) {
    return localResult.result;
  }

  const id = bridge.reserveLocalRequestId();
  return new Promise<unknown>((resolve, reject) => {
    bridge.localRequests.set(id, { method, params, resolve, reject });
    bridge.sendJsonRpcMessage({ id, method, params });
  });
}

export function rejectPendingRequests(bridge: LifecycleContext, error: Error): void {
  bridge.localRequests.forEach(({ reject }) => reject(error));
  bridge.localRequests.clear();
  bridge.pendingRemoteRequestMethods.clear();
  bridge.pendingRemoteRequestParams.clear();
}
