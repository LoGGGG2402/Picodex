import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";


import {
  createDroppedBrowserBridgeMessageTypes,
  createLocalBrowserBridgeHandlers,
} from "./browser-bridge-handlers.js";
import {
  handleFetchCancel as cancelFetchRequest,
  handleFetchRequest as handleBridgeFetchRequest,
} from "./fetch-routing.js";
import {
  readAutoTopUpSettings as readStoredAutoTopUpSettings,
  readConfigValue as readStoredConfigValue,
  readLocalEnvironment as readStoredLocalEnvironment,
  readLocalEnvironmentConfig as readStoredLocalEnvironmentConfig,
  readOpenInTargets as readConfiguredOpenInTargets,
  readTerminalShellOptions as readHostTerminalShellOptions,
  updateAutoTopUpSettings as updateStoredAutoTopUpSettings,
  writeLocalEnvironmentConfig as writeStoredLocalEnvironmentConfig,
  writePreferredOpenTarget as writeConfiguredOpenInTarget,
} from "./host-state.js";
import {
  bindGitWorker as bindBridgeGitWorker,
  bindProcess as bindBridgeProcess,
  handleIpcRequest as handleBridgeIpcRequest,
  handleLocalJsonRpcRequest as handleBridgeLocalJsonRpcRequest,
  initialize as initializeBridge,
  listExperimentalFeatures as listBridgeExperimentalFeatures,
  restoreGlobalStateRegistry as restoreBridgeGlobalStateRegistry,
  restorePersistedAtomRegistry as restoreBridgePersistedAtomRegistry,
  restoreWorkspaceRootRegistry as restoreBridgeWorkspaceRootRegistry,
  sendLocalRequest as sendBridgeLocalRequest,
  setExperimentalFeatureEnablement as setBridgeExperimentalFeatureEnablement,
} from "./lifecycle.js";
import {
  handleFuzzyFileSearch as handleFuzzyFileSearchRequest,
  highlightWorkspaceFile as highlightWorkspaceBrowserFile,
  listHostDirectory as listHostDirectoryEntries,
  listWorkspaceDirectory as listWorkspaceDirectoryEntries,
  listWorkspaceFileRoots as listWorkspaceFileRootOptions,
  readWorkspaceFile as readWorkspaceBrowserFile,
  resolveHostFiles as resolveHostFileEntries,
  resolveWorkspaceFileDownload as resolveWorkspaceBrowserFileDownload,
  searchWorkspaceBrowserFiles as searchWorkspaceBrowserFileEntries,
  startFuzzyFileSearchSession as startFuzzySearchSession,
  stopFuzzyFileSearchSession as stopFuzzySearchSession,
  updateFuzzyFileSearchSession as updateFuzzySearchSession,
} from "./file-browser-handlers.js";
import {
  emitConnectionState as emitProtocolConnectionState,
  handleMcpNotification as handleProtocolMcpNotification,
  handleMcpRequest as handleProtocolMcpRequest,
  handleMcpResponse as handleProtocolMcpResponse,
  handlePersistedAtomUpdate as handleProtocolPersistedAtomUpdate,
  handleSharedObjectSet as handleProtocolSharedObjectSet,
  handleSharedObjectSubscribe as handleProtocolSharedObjectSubscribe,
  handleSharedObjectUnsubscribe as handleProtocolSharedObjectUnsubscribe,
  handleStdoutLine as handleProtocolStdoutLine,
  handleThreadArchive as handleProtocolThreadArchive,
  handleThreadRoleRequest as handleProtocolThreadRoleRequest,
  type ProtocolHandlersContext,
} from "./protocol-handlers.js";
import {
  buildHostConfig as buildRuntimeHostConfig,
  emitFetchError as emitRuntimeFetchError,
  emitFetchSuccess as emitRuntimeFetchSuccess,
  handleElectronAppStateSnapshotTrigger as handleRuntimeAppStateSnapshotTrigger,
  queueGlobalStateRegistryWrite as queueRuntimeGlobalStateRegistryWrite,
  scheduleSyntheticCollabHydrationNotifications as scheduleRuntimeSyntheticHydration,
  setPinnedThreadsOrder as setRuntimePinnedThreadsOrder,
  setThreadPinned as setRuntimeThreadPinned,
  writeGlobalState as writeRuntimeGlobalState,
} from "./runtime-state.js";
import {
  DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT,
  EXPERIMENTAL_FEATURES_STATE_KEY,
  type AppServerBridgeOptions,
  type AppServerFetchCancel,
  type AppServerFetchRequest,
  type AppServerMcpNotificationEnvelope,
  type AppServerMcpRequestEnvelope,
  type AppServerMcpResponseEnvelope,
  type AutoTopUpSettings,
  type FuzzyFileSearchSession,
  type HostBrowserEntry,
  type LocalEnvironmentDocument,
  type OpenInTarget,
  type PendingLocalRequest,
  type PersistedAtomUpdateMessage,
  type SessionSubagentMetadata,
  type SessionSyntheticCollabCallRecord,
  type SessionThreadIndexRecord,
  type TopLevelRequestMessage,
  type WorkspaceBrowserEntry,
  type WorkspaceBrowserRoot,
  type WorkspaceBrowserSearchResult,
} from "./shared.js";
import {
  enrichThreadPayloadForMethod,
  type ThreadRecordsBridgeContext,
} from "./thread-records.js";
import {
  isJsonRecord,
  normalizeError,
  normalizeExperimentalFeatureEnablementMap,
} from "./utils.js";
import {
  addManualWorkspaceRoot as addManualWorkspaceRootOption,
  addWorkspaceRootOption as addWorkspaceRootOptionEntry,
  applyDesktopWorkspaceImports as importDesktopWorkspaceRoots,
  applyWorkspaceRootRegistry as restoreWorkspaceRootsState,
  dismissDesktopWorkspaceImportPrompt as dismissWorkspaceImportPrompt,
  getActiveWorkspaceRoots as getTrackedActiveWorkspaceRoots,
  getGitOriginFallbackDirectories as getTrackedGitOriginFallbackDirectories,
  handleOnboardingPickWorkspaceOrCreateDefault as handleWorkspaceOnboardingPick,
  handleOnboardingSkipWorkspace as handleWorkspaceOnboardingSkip,
  handleRenameWorkspaceRootOption as renameWorkspaceRootOption,
  handleSetActiveWorkspaceRoot as setTrackedActiveWorkspaceRoot,
  handleWorkspaceRootsUpdated as updateTrackedWorkspaceRoots,
  listDesktopWorkspaceImportCandidates as listDesktopWorkspaceCandidates,
  openDesktopImportDialog as openWorkspaceImportDialog,
  pickDesktopWorkspaceDirectory as pickWorkspaceDirectory,
  syncWorkspaceGlobalState as syncTrackedWorkspaceGlobalState,
} from "./workspace-management.js";
import {
  deriveCodexDesktopGlobalStatePath,
} from "../desktop/codex-desktop-projects.js";
import { resolveCodexHomePath } from "../desktop/codex-home.js";
import {
  DefaultCodexDesktopGitWorkerBridge,
  type CodexDesktopGitWorkerBridge,
} from "../desktop/codex-desktop-git-worker.js";
import { debugLog, warnOnceLog } from "../core/debug.js";
import type { HostBridge, JsonRecord } from "../core/protocol.js";
import { deriveCodexCliBinaryPath } from "../desktop/startup-errors.js";
import {
  derivePersistedAtomRegistryPath,
} from "../state/persisted-atom-registry.js";
import {
  deriveGlobalStateRegistryPath,
} from "../state/global-state-registry.js";
import {
  deriveWorkspaceRootRegistryPath,
  type WorkspaceRootRegistryState,
} from "../state/workspace-root-registry.js";
import {
  TerminalSessionManager,
} from "../terminal/session-manager.js";

export class AppServerBridge extends EventEmitter implements HostBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly hostId: string;
  private readonly cwd: string;
  private readonly terminalManager: TerminalSessionManager;
  private readonly localRequests = new Map<string, PendingLocalRequest>();
  private readonly pendingRemoteRequestMethods = new Map<string, string>();
  private readonly pendingRemoteRequestParams = new Map<string, unknown>();
  private readonly fetchRequests = new Map<string, AbortController>();
  private readonly persistedAtoms = new Map<string, unknown>();
  private readonly globalState = new Map<string, unknown>();
  private readonly pinnedThreadIds = new Set<string>();
  private readonly sharedObjects = new Map<string, unknown>();
  private readonly sharedObjectSubscriptions = new Set<string>();
  private readonly sessionSubagentMetadataCache = new Map<string, Promise<SessionSubagentMetadata | null>>();
  private readonly sessionThreadIndexCache = new Map<string, Promise<SessionThreadIndexRecord | null>>();
  private readonly sessionSyntheticCollabCallCache = new Map<string, Promise<SessionSyntheticCollabCallRecord[]>>();
  private readonly syntheticCollabHydrationTimers = new Set<NodeJS.Timeout>();
  private readonly workspaceRoots = new Set<string>();
  private readonly workspaceRootLabels = new Map<string, string>();
  private readonly fuzzyFileSearchSessions = new Map<string, FuzzyFileSearchSession>();
  private readonly codexDesktopGlobalStatePath: string;
  private readonly persistedAtomRegistryPath: string;
  private readonly globalStateRegistryPath: string;
  private readonly workspaceRootRegistryPath: string;
  private readonly gitWorkerBridge: CodexDesktopGitWorkerBridge;
  private activeWorkspaceRoot: string | null;
  private desktopImportPromptSeen = false;
  private persistedAtomWritePromise: Promise<void> = Promise.resolve();
  private globalStateWritePromise: Promise<void> = Promise.resolve();
  private nextRequestId = 0;
  private isClosing = false;
  private isInitialized = false;
  private connectionState: "connecting" | "connected" | "disconnected" = "connecting";
  private readonly droppedBrowserBridgeMessageTypes = createDroppedBrowserBridgeMessageTypes();
  private readonly localBrowserBridgeHandlers: Map<
    string,
    (message: JsonRecord & { type: string }) => Promise<void> | void
  >;

  override on(event: "bridge_message", listener: (message: unknown) => void): this;
  override on(
    event: "worker_message",
    listener: (workerName: string, message: unknown) => void,
  ): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: string | symbol, listener: (...arguments_: any[]) => void): this {
    return super.on(event, listener);
  }

  private constructor(options: AppServerBridgeOptions) {
    super();
    this.hostId = options.hostId ?? "local";
    this.cwd = options.cwd;
    this.codexDesktopGlobalStatePath =
      options.codexDesktopGlobalStatePath ?? deriveCodexDesktopGlobalStatePath();
    this.persistedAtomRegistryPath =
      options.persistedAtomRegistryPath ?? derivePersistedAtomRegistryPath();
    this.globalStateRegistryPath =
      options.globalStateRegistryPath ?? deriveGlobalStateRegistryPath();
    this.workspaceRootRegistryPath =
      options.workspaceRootRegistryPath ?? deriveWorkspaceRootRegistryPath();
    this.gitWorkerBridge =
      options.gitWorkerBridge ??
      new DefaultCodexDesktopGitWorkerBridge({
        appPath: options.appPath,
        appAsarPath: options.appAsarPath,
        codexAppSessionId: randomUUID(),
      });
    this.activeWorkspaceRoot = null;
    this.sharedObjects.set("host_config", this.buildHostConfig());
    this.sharedObjects.set("remote_connections", []);
    this.sharedObjects.set("diff_comments", []);
    this.sharedObjects.set("diff_comments_from_model", []);
    this.sharedObjects.set("composer_prefill", null);
    this.sharedObjects.set("skills_refresh_nonce", 0);
    this.terminalManager = new TerminalSessionManager({
      cwd: this.cwd,
      emitBridgeMessage: (message) => {
        this.emitBridgeMessage(message);
      },
    });
    this.localBrowserBridgeHandlers = new Map(
      createLocalBrowserBridgeHandlers(this.createBrowserBridgeHandlersContext()),
    );
    this.child = spawn(
      deriveCodexCliBinaryPath(options.codexCliPath),
      ["app-server", "--listen", "stdio://"],
      {
        stdio: "pipe",
      },
    );

    this.bindProcess();
    this.bindGitWorker();
  }

  static async connect(options: AppServerBridgeOptions): Promise<AppServerBridge> {
    const bridge = new AppServerBridge(options);
    await bridge.restorePersistedAtomRegistry();
    await bridge.restoreGlobalStateRegistry();
    await bridge.restoreWorkspaceRootRegistry();
    await bridge.initialize();
    return bridge;
  }

  async close(): Promise<void> {
    this.isClosing = true;
    this.connectionState = "disconnected";
    for (const timer of this.syntheticCollabHydrationTimers) {
      clearTimeout(timer);
    }
    this.syntheticCollabHydrationTimers.clear();
    this.fetchRequests.forEach((controller) => controller.abort());
    this.fetchRequests.clear();
    this.terminalManager.dispose();
    await this.gitWorkerBridge.close().catch((error) => {
      debugLog("git-worker", "failed to close desktop git worker bridge", {
        error: normalizeError(error).message,
      });
    });

    if (!this.child.killed) {
      this.child.kill();
    }

    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      setTimeout(() => resolve(), 1_000);
    });

    await this.persistedAtomWritePromise.catch(() => undefined);
    await this.globalStateWritePromise.catch(() => undefined);
  }

  async forwardBridgeMessage(message: unknown): Promise<void> {
    if (!isJsonRecord(message) || typeof message.type !== "string") {
      return;
    }

    const typedMessage = message as JsonRecord & { type: string };
    const localHandler = this.localBrowserBridgeHandlers.get(typedMessage.type);
    if (localHandler) {
      await localHandler(typedMessage);
      return;
    }

    if (this.isDroppedBrowserBridgeMessage(typedMessage)) {
      return;
    }

    warnOnceLog(
      "app-server",
      `unrouted-browser-bridge:${typedMessage.type}`,
      "browser bridge message has no Picodex host route and will be dropped",
      {
        type: typedMessage.type,
      },
    );
  }

  async sendWorkerMessage(workerName: string, message: unknown): Promise<void> {
    if (workerName === "git") {
      await this.gitWorkerBridge.send(message);
      return;
    }

    if (!isJsonRecord(message) || message.type !== "worker-request") {
      return;
    }

    const workerId = typeof message.workerId === "string" ? message.workerId : workerName;
    const request = isJsonRecord(message.request) ? message.request : null;
    const requestId =
      request && (typeof request.id === "string" || typeof request.id === "number")
        ? request.id
        : "";
    const method = request && typeof request.method === "string" ? request.method : "unknown";

    this.emit("worker_message", workerName, {
      type: "worker-response",
      workerId,
      response: {
        id: requestId,
        method,
        result: {
          type: "error",
          error: {
            message: `Worker "${workerName}" is not available in Picodex yet.`,
          },
        },
      },
    });
  }

  async subscribeWorker(workerName: string): Promise<void> {
    if (workerName === "git") {
      await this.gitWorkerBridge.subscribe();
    }
  }

  async unsubscribeWorker(workerName: string): Promise<void> {
    if (workerName === "git") {
      await this.gitWorkerBridge.unsubscribe();
    }
  }

  async handleIpcRequest(payload: unknown): Promise<unknown> {
    return handleBridgeIpcRequest(this.createLifecycleContext(), payload);
  }

  private bindProcess(): void {
    bindBridgeProcess(this.createLifecycleContext());
  }

  private bindGitWorker(): void {
    bindBridgeGitWorker(this.createLifecycleContext());
  }

  private async initialize(): Promise<void> {
    await initializeBridge(this.createLifecycleContext());
  }

  private async restoreWorkspaceRootRegistry(): Promise<void> {
    await restoreBridgeWorkspaceRootRegistry(this.createLifecycleContext());
  }

  private async restorePersistedAtomRegistry(): Promise<void> {
    await restoreBridgePersistedAtomRegistry(this.createLifecycleContext());
  }

  private async restoreGlobalStateRegistry(): Promise<void> {
    await restoreBridgeGlobalStateRegistry(this.createLifecycleContext());
  }

  private async listDesktopWorkspaceImportCandidates(): Promise<{ found: boolean; path: string; promptSeen: boolean; shouldPrompt: boolean; projects: Array<{ root: string; label: string; activeInCodex: boolean; alreadyImported: boolean; available: boolean }> }> { return listDesktopWorkspaceCandidates(this.createWorkspaceManagementContext()); }
  private async applyDesktopWorkspaceImports(params: unknown): Promise<{ importedRoots: string[]; skippedRoots: string[]; promptSeen: boolean }> { return importDesktopWorkspaceRoots(this.createWorkspaceManagementContext(), params); }
  private async addManualWorkspaceRoot(params: unknown): Promise<{ addedRoot: string | null; promptSeen: boolean }> { return addManualWorkspaceRootOption(this.createWorkspaceManagementContext(), params); }
  private async pickDesktopWorkspaceDirectory(params: unknown): Promise<{ pickedRoot: string | null }> { return pickWorkspaceDirectory(this.createWorkspaceManagementContext(), params); }
  private async dismissDesktopWorkspaceImportPrompt(): Promise<{ promptSeen: boolean }> { return dismissWorkspaceImportPrompt(this.createWorkspaceManagementContext()); }
  private async resolveHostFiles(params: unknown): Promise<{ files: Array<{ label: string; path: string; fsPath: string }> }> { return resolveHostFileEntries(this.createFileBrowserContext(), params); }
  private async listHostDirectory(params: unknown): Promise<{ path: string; entries: HostBrowserEntry[] }> { return listHostDirectoryEntries(this.createFileBrowserContext(), params); }
  private async handleFuzzyFileSearch(params: unknown): Promise<{ files: string[] }> { return handleFuzzyFileSearchRequest(this.createFileBrowserContext(), params); }
  private async listWorkspaceFileRoots(): Promise<{ roots: WorkspaceBrowserRoot[] }> { return listWorkspaceFileRootOptions(this.createFileBrowserContext()); }
  private async listWorkspaceDirectory(params: unknown): Promise<{ root: string; path: string; relativePath: string; entries: WorkspaceBrowserEntry[] }> { return listWorkspaceDirectoryEntries(this.createFileBrowserContext(), params); }
  private async readWorkspaceFile(params: unknown): Promise<{ root: string; path: string; relativePath: string; kind: "text" | "image" | "pdf" | "binary"; mimeType: string; size: number; contents?: string; contentsBase64?: string }> { return readWorkspaceBrowserFile(this.createFileBrowserContext(), params); }
  private async highlightWorkspaceFile(params: unknown): Promise<{ html: string; language: string }> { return highlightWorkspaceBrowserFile(this.createFileBrowserContext(), params); }
  async resolveWorkspaceFileDownload(filePath: string): Promise<{ path: string; fileName: string; mimeType: string; size: number }> { return resolveWorkspaceBrowserFileDownload(this.createFileBrowserContext(), filePath); }
  private async searchWorkspaceBrowserFiles(params: unknown): Promise<{ query: string; files: WorkspaceBrowserSearchResult[] }> { return searchWorkspaceBrowserFileEntries(this.createFileBrowserContext(), params); }
  private async startFuzzyFileSearchSession(params: unknown): Promise<{ sessionId: string; roots: string[] }> { return startFuzzySearchSession(this.createFileBrowserContext(), params); }
  private async updateFuzzyFileSearchSession(params: unknown): Promise<{ sessionId: string; query: string; files: string[] }> { return updateFuzzySearchSession(this.createFileBrowserContext(), params); }
  private async stopFuzzyFileSearchSession(params: unknown): Promise<{ sessionId: string; stopped: boolean }> { return stopFuzzySearchSession(this.createFileBrowserContext(), params); }

  private emitConnectionState(): void { emitProtocolConnectionState(this.createProtocolHandlersContext()); }
  private async handleStdoutLine(line: string): Promise<void> { await handleProtocolStdoutLine(this.createProtocolHandlersContext(), line); }
  private async handleMcpRequest(message: AppServerMcpRequestEnvelope): Promise<void> { await handleProtocolMcpRequest(this.createProtocolHandlersContext(), message); }
  private async handleMcpNotification(message: AppServerMcpNotificationEnvelope): Promise<void> { await handleProtocolMcpNotification(this.createProtocolHandlersContext(), message); }
  private async handleMcpResponse(message: AppServerMcpResponseEnvelope): Promise<void> { await handleProtocolMcpResponse(this.createProtocolHandlersContext(), message); }
  private async handleThreadArchive(message: JsonRecord, method: "thread/archive" | "thread/unarchive"): Promise<void> { await handleProtocolThreadArchive(this.createProtocolHandlersContext(), message, method); }
  private handleThreadRoleRequest(message: TopLevelRequestMessage): void { handleProtocolThreadRoleRequest(this.createProtocolHandlersContext(), message); }
  private async handleFetchRequest(message: AppServerFetchRequest): Promise<void> { await handleBridgeFetchRequest(this.createFetchRoutingContext(), message); }
  private handleFetchCancel(message: AppServerFetchCancel): void { cancelFetchRequest(this.createFetchRoutingContext(), message.requestId); }
  private handlePersistedAtomUpdate(message: PersistedAtomUpdateMessage): void { handleProtocolPersistedAtomUpdate(this.createProtocolHandlersContext(), message); }
  private handleSharedObjectSubscribe(message: JsonRecord): void { handleProtocolSharedObjectSubscribe(this.createProtocolHandlersContext(), message); }
  private handleSharedObjectUnsubscribe(message: JsonRecord): void { handleProtocolSharedObjectUnsubscribe(this.createProtocolHandlersContext(), message); }
  private handleSharedObjectSet(message: JsonRecord): void { handleProtocolSharedObjectSet(this.createProtocolHandlersContext(), message); }
  private async handleOnboardingPickWorkspaceOrCreateDefault(): Promise<void> { await handleWorkspaceOnboardingPick(this.createWorkspaceManagementContext()); }
  private async handleOnboardingSkipWorkspace(): Promise<void> { await handleWorkspaceOnboardingSkip(this.createWorkspaceManagementContext()); }
  private async handleWorkspaceRootsUpdated(message: JsonRecord): Promise<void> { await updateTrackedWorkspaceRoots(this.createWorkspaceManagementContext(), message); }
  private async handleSetActiveWorkspaceRoot(message: JsonRecord): Promise<void> { await setTrackedActiveWorkspaceRoot(this.createWorkspaceManagementContext(), message); }
  private async handleRenameWorkspaceRootOption(message: JsonRecord): Promise<void> { await renameWorkspaceRootOption(this.createWorkspaceManagementContext(), message); }

  private readConfigValue(body: unknown): { value: unknown } { return readStoredConfigValue(this.createHostStateContext(), body); }
  private readOpenInTargets(): { preferredTarget: string; targets: OpenInTarget[]; availableTargets: OpenInTarget[] } { return readConfiguredOpenInTargets(this.createHostStateContext()); }
  private writePreferredOpenTarget(body: unknown): { target: string } { return writeConfiguredOpenInTarget(this.createHostStateContext(), body); }
  private readTerminalShellOptions(): { availableShells: string[] } { return readHostTerminalShellOptions(); }
  private readAutoTopUpSettings(): AutoTopUpSettings { return readStoredAutoTopUpSettings(this.createHostStateContext()); }
  private updateAutoTopUpSettings(body: unknown, options: { enabled?: boolean; clearThresholds?: boolean } = {}): AutoTopUpSettings & { immediate_top_up_status: null } { return updateStoredAutoTopUpSettings(this.createHostStateContext(), body, options); }

  private async readLocalEnvironmentConfig(body: unknown): Promise<{ configPath: string; exists: boolean }> { return readStoredLocalEnvironmentConfig(this.createHostStateContext(), body); }
  private async readLocalEnvironment(body: unknown): Promise<{ environment: { type: "success"; environment: LocalEnvironmentDocument } | { type: "error"; error: { message: string } } }> { return readStoredLocalEnvironment(this.createHostStateContext(), body); }
  private async writeLocalEnvironmentConfig(body: unknown): Promise<{ configPath: string }> { return writeStoredLocalEnvironmentConfig(this.createHostStateContext(), body); }
  private getCodexHomePath(): string { return resolveCodexHomePath(); }

  private sanitizeMcpParams(method: string, params: unknown): unknown {
    if (!isJsonRecord(params)) {
      return params;
    }

    switch (method) {
      case "thread/start":
        return this.sanitizeThreadStartParams(params);
      case "thread/resume":
        return this.sanitizeThreadResumeParams(params);
      default:
        return params;
    }
  }

  private sanitizeThreadStartParams(params: JsonRecord): JsonRecord { return this.sanitizeThreadParams(params); }
  private sanitizeThreadResumeParams(params: JsonRecord): JsonRecord { return this.sanitizeThreadParams(params); }
  private sanitizeThreadParams(params: JsonRecord): JsonRecord {
    const sanitized: JsonRecord = { ...params };
    const config = isJsonRecord(params.config) ? params.config : null;
    if (typeof sanitized.model !== "string" && config && typeof config.model === "string") sanitized.model = config.model;
    delete sanitized.config;
    delete sanitized.modelProvider;
    return sanitized;
  }

  private writeGlobalState(body: unknown): Record<string, never> {
    return writeRuntimeGlobalState(this.createRuntimeStateContext(), body);
  }

  private setThreadPinned(body: unknown): Record<string, never> {
    return setRuntimeThreadPinned(this.createRuntimeStateContext(), body);
  }

  private setPinnedThreadsOrder(body: unknown): Record<string, never> {
    return setRuntimePinnedThreadsOrder(this.createRuntimeStateContext(), body);
  }

  private async addWorkspaceRootOption(body: unknown): Promise<{ success: boolean; root: string }> {
    return addWorkspaceRootOptionEntry(this.createWorkspaceManagementContext(), body);
  }

  private applyWorkspaceRootRegistry(state: WorkspaceRootRegistryState): void {
    restoreWorkspaceRootsState(this.createWorkspaceManagementContext(), state);
  }


  private syncWorkspaceGlobalState(): void { syncTrackedWorkspaceGlobalState(this.createWorkspaceManagementContext()); }
  private queueGlobalStateRegistryWrite(): void { queueRuntimeGlobalStateRegistryWrite(this.createRuntimeStateContext()); }
  private getActiveWorkspaceRoots(): string[] { return getTrackedActiveWorkspaceRoots(this.createWorkspaceManagementContext()); }
  private getGitOriginFallbackDirectories(): string[] { return getTrackedGitOriginFallbackDirectories(this.createWorkspaceManagementContext()); }
  private openDesktopImportDialog(mode: "first-run" | "manual"): void { openWorkspaceImportDialog(this.createWorkspaceManagementContext(), mode); }

  private createWorkspaceManagementContext() {
    return {
      cwd: this.cwd,
      codexDesktopGlobalStatePath: this.codexDesktopGlobalStatePath,
      workspaceRootRegistryPath: this.workspaceRootRegistryPath,
      workspaceRoots: this.workspaceRoots,
      workspaceRootLabels: this.workspaceRootLabels,
      globalState: this.globalState,
      pinnedThreadIds: this.pinnedThreadIds,
      getActiveWorkspaceRoot: () => this.activeWorkspaceRoot,
      setActiveWorkspaceRoot: (root: string | null) => { this.activeWorkspaceRoot = root; },
      getDesktopImportPromptSeen: () => this.desktopImportPromptSeen,
      setDesktopImportPromptSeen: (seen: boolean) => { this.desktopImportPromptSeen = seen; },
      queueGlobalStateRegistryWrite: () => { this.queueGlobalStateRegistryWrite(); },
      emitBridgeMessage: (message: { type: string; [key: string]: unknown }) => { this.emitBridgeMessage(message as JsonRecord); },
    };
  }

  private createBrowserBridgeHandlersContext() {
    return {
      emitConnectionState: () => this.emitConnectionState(),
      persistedAtoms: this.persistedAtoms,
      handlePersistedAtomUpdate: (message: PersistedAtomUpdateMessage) => this.handlePersistedAtomUpdate(message),
      handleSharedObjectSubscribe: (message: JsonRecord) => this.handleSharedObjectSubscribe(message),
      handleSharedObjectUnsubscribe: (message: JsonRecord) => this.handleSharedObjectUnsubscribe(message),
      handleSharedObjectSet: (message: JsonRecord) => this.handleSharedObjectSet(message),
      handleThreadArchive: (message: JsonRecord, method: "thread/archive" | "thread/unarchive") => this.handleThreadArchive(message, method),
      handleThreadRoleRequest: (message: TopLevelRequestMessage) => this.handleThreadRoleRequest(message),
      handleOnboardingPickWorkspaceOrCreateDefault: () => this.handleOnboardingPickWorkspaceOrCreateDefault(),
      handleOnboardingSkipWorkspace: () => this.handleOnboardingSkipWorkspace(),
      openDesktopImportDialog: (mode: "first-run" | "manual") => this.openDesktopImportDialog(mode),
      handleWorkspaceRootsUpdated: (message: JsonRecord) => this.handleWorkspaceRootsUpdated(message),
      handleSetActiveWorkspaceRoot: (message: JsonRecord) => this.handleSetActiveWorkspaceRoot(message),
      handleRenameWorkspaceRootOption: (message: JsonRecord) => this.handleRenameWorkspaceRootOption(message),
      handleMcpRequest: (message: AppServerMcpRequestEnvelope) => this.handleMcpRequest(message),
      handleMcpNotification: (message: AppServerMcpNotificationEnvelope) => this.handleMcpNotification(message),
      handleMcpResponse: (message: AppServerMcpResponseEnvelope) => this.handleMcpResponse(message),
      terminalManager: this.terminalManager,
      handleFetchRequest: (message: AppServerFetchRequest) => this.handleFetchRequest(message),
      handleFetchCancel: (message: AppServerFetchCancel) => this.handleFetchCancel(message),
      emitBridgeMessage: (message: JsonRecord) => this.emitBridgeMessage(message),
      handleElectronAppStateSnapshotTrigger: (message: JsonRecord & { type: string }) => this.handleElectronAppStateSnapshotTrigger(message),
    };
  }

  private createLifecycleContext() {
    return {
      hostId: this.hostId,
      child: this.child,
      gitWorkerBridge: this.gitWorkerBridge,
      codexDesktopGlobalStatePath: this.codexDesktopGlobalStatePath,
      persistedAtomRegistryPath: this.persistedAtomRegistryPath,
      globalStateRegistryPath: this.globalStateRegistryPath,
      workspaceRootRegistryPath: this.workspaceRootRegistryPath,
      cwd: this.cwd,
      localRequests: this.localRequests,
      pendingRemoteRequestMethods: this.pendingRemoteRequestMethods,
      pendingRemoteRequestParams: this.pendingRemoteRequestParams,
      persistedAtoms: this.persistedAtoms,
      globalState: this.globalState,
      pinnedThreadIds: this.pinnedThreadIds,
      isClosing: this.isClosing,
      isInitialized: this.isInitialized,
      connectionState: this.connectionState,
      desktopImportPromptSeen: this.desktopImportPromptSeen,
      reserveLocalRequestId: () => `picodex-local-${++this.nextRequestId}`,
      setIsInitialized: (next: boolean) => { this.isInitialized = next; },
      setConnectionState: (next: "connecting" | "connected" | "disconnected") => { this.connectionState = next; },
      setDesktopImportPromptSeen: (next: boolean) => { this.desktopImportPromptSeen = next; },
      emit: (event: "worker_message" | "bridge_message" | "error", ...args: unknown[]) => this.emit(event, ...(args as [unknown])),
      emitConnectionState: () => this.emitConnectionState(),
      handleStdoutLine: (line: string) => this.handleStdoutLine(line),
      applyWorkspaceRootRegistry: (state: unknown) => this.applyWorkspaceRootRegistry(state as WorkspaceRootRegistryState),
      syncWorkspaceGlobalState: () => this.syncWorkspaceGlobalState(),
      sendJsonRpcMessage: (message: Record<string, unknown>) => this.sendJsonRpcMessage(message as JsonRecord),
      handleIpcRequest: (payload: unknown) => this.handleIpcRequest(payload),
      listDesktopWorkspaceImportCandidates: () => this.listDesktopWorkspaceImportCandidates(),
      applyDesktopWorkspaceImports: (params: unknown) => this.applyDesktopWorkspaceImports(params),
      addManualWorkspaceRoot: (params: unknown) => this.addManualWorkspaceRoot(params),
      pickDesktopWorkspaceDirectory: (params: unknown) => this.pickDesktopWorkspaceDirectory(params),
      dismissDesktopWorkspaceImportPrompt: () => this.dismissDesktopWorkspaceImportPrompt(),
      handleFuzzyFileSearch: (params: unknown) => this.handleFuzzyFileSearch(params),
      startFuzzyFileSearchSession: (params: unknown) => this.startFuzzyFileSearchSession(params),
      updateFuzzyFileSearchSession: (params: unknown) => this.updateFuzzyFileSearchSession(params),
      stopFuzzyFileSearchSession: (params: unknown) => this.stopFuzzyFileSearchSession(params),
      resolveHostFiles: (params: unknown) => this.resolveHostFiles(params),
      listHostDirectory: (params: unknown) => this.listHostDirectory(params),
      listWorkspaceFileRoots: () => this.listWorkspaceFileRoots(),
      listWorkspaceDirectory: (params: unknown) => this.listWorkspaceDirectory(params),
      readWorkspaceFile: (params: unknown) => this.readWorkspaceFile(params),
      highlightWorkspaceFile: (params: unknown) => this.highlightWorkspaceFile(params),
      searchWorkspaceBrowserFiles: (params: unknown) => this.searchWorkspaceBrowserFiles(params),
      handleLocalJsonRpcRequest: (method: string, params: unknown) => this.handleLocalJsonRpcRequest(method, params),
      listExperimentalFeatures: (params: unknown) => this.listExperimentalFeatures(params),
      setExperimentalFeatureEnablement: (params: unknown) => this.setExperimentalFeatureEnablement(params),
      getExperimentalFeatureEnablement: () => this.getExperimentalFeatureEnablement(),
      queueGlobalStateRegistryWrite: () => this.queueGlobalStateRegistryWrite(),
    };
  }

  private createFileBrowserContext() {
    return {
      cwd: this.cwd,
      workspaceRootLabels: this.workspaceRootLabels,
      fuzzyFileSearchSessions: this.fuzzyFileSearchSessions,
      getActiveWorkspaceRoots: () => this.getActiveWorkspaceRoots(),
      emitBridgeMessage: (message: { type: string; [key: string]: unknown }) => { this.emitBridgeMessage(message as JsonRecord); },
    };
  }

  private createWorkspaceBrowserContext() { return { cwd: this.cwd, getActiveWorkspaceRoots: () => this.getActiveWorkspaceRoots() }; }

  private createHostStateContext() {
    return {
      cwd: this.cwd,
      globalState: this.globalState,
      queueGlobalStateRegistryWrite: () => { this.queueGlobalStateRegistryWrite(); },
      sendLocalRequest: (method: string, params?: unknown) => this.sendLocalRequest(method, params),
    };
  }

  private createFetchRoutingContext() {
    return {
      ...this.createHostStateContext(),
      fetchRequests: this.fetchRequests,
      handleIpcRequest: (payload: unknown) => this.handleIpcRequest(payload),
      getActiveWorkspaceRoots: () => this.getActiveWorkspaceRoots(),
      workspaceRoots: this.workspaceRoots,
      workspaceRootLabels: this.workspaceRootLabels,
      pinnedThreadIds: this.pinnedThreadIds,
      writeGlobalState: (body: unknown) => this.writeGlobalState(body),
      setThreadPinned: (body: unknown) => this.setThreadPinned(body),
      setPinnedThreadsOrder: (body: unknown) => this.setPinnedThreadsOrder(body),
      addWorkspaceRootOption: (body: unknown) => this.addWorkspaceRootOption(body),
      readConfigValue: (body: unknown) => this.readConfigValue(body),
      readLocalEnvironmentConfig: (body: unknown) => this.readLocalEnvironmentConfig(body),
      readLocalEnvironment: (body: unknown) => this.readLocalEnvironment(body),
      writeLocalEnvironmentConfig: (body: unknown) => this.writeLocalEnvironmentConfig(body),
      readOpenInTargets: () => this.readOpenInTargets(),
      writePreferredOpenTarget: (body: unknown) => this.writePreferredOpenTarget(body),
      readTerminalShellOptions: () => this.readTerminalShellOptions(),
      readAutoTopUpSettings: () => this.readAutoTopUpSettings(),
      updateAutoTopUpSettings: (body: unknown, options?: { enabled?: boolean; clearThresholds?: boolean }) => this.updateAutoTopUpSettings(body, options),
      getGitOriginFallbackDirectories: () => this.getGitOriginFallbackDirectories(),
      emitBridgeMessage: (message: { type: string; [key: string]: unknown }) => { this.emitBridgeMessage(message as JsonRecord); },
      emitFetchSuccess: (requestId: string, body: unknown, status?: number) => { this.emitFetchSuccess(requestId, body, status); },
      emitFetchError: (requestId: string, status: number, error: string) => { this.emitFetchError(requestId, status, error); },
    };
  }

  private createProtocolHandlersContext(): ProtocolHandlersContext {
    return {
      hostId: this.hostId,
      connectionState: this.connectionState,
      isInitialized: this.isInitialized,
      localRequests: this.localRequests,
      pendingRemoteRequestMethods: this.pendingRemoteRequestMethods,
      pendingRemoteRequestParams: this.pendingRemoteRequestParams,
      persistedAtoms: this.persistedAtoms,
      sharedObjects: this.sharedObjects,
      sharedObjectSubscriptions: this.sharedObjectSubscriptions,
      persistedAtomRegistryPath: this.persistedAtomRegistryPath,
      getPersistedAtomWritePromise: () => this.persistedAtomWritePromise,
      setPersistedAtomWritePromise: (promise: Promise<void>) => { this.persistedAtomWritePromise = promise; },
      emit: (event: "bridge_message" | "error", ...args: unknown[]) => this.emit(event, ...(args as [unknown])),
      emitBridgeMessage: (message: JsonRecord) => { this.emitBridgeMessage(message); },
      sendJsonRpcMessage: (message: JsonRecord) => { this.sendJsonRpcMessage(message); },
      enrichThreadPayloadForMethod: (method: string | null, payload: unknown, requestParams?: unknown) => this.enrichThreadPayloadForMethod(method, payload, requestParams),
      scheduleSyntheticCollabHydrationNotifications: (method: string | null, result: unknown) => { this.scheduleSyntheticCollabHydrationNotifications(method, result); },
      handleLocalJsonRpcRequest: (method: string, params: unknown) => this.handleLocalJsonRpcRequest(method, params),
      sanitizeMcpParams: (method: string, params: unknown) => this.sanitizeMcpParams(method, params),
      sendLocalRequest: (method: string, params?: unknown) => this.sendLocalRequest(method, params),
    };
  }

  private createRuntimeStateContext() {
    return {
      hostId: this.hostId,
      globalState: this.globalState,
      pinnedThreadIds: this.pinnedThreadIds,
      globalStateRegistryPath: this.globalStateRegistryPath,
      globalStateWritePromise: this.globalStateWritePromise,
      syntheticCollabHydrationTimers: this.syntheticCollabHydrationTimers,
      isClosing: this.isClosing,
      getActiveWorkspaceRoots: () => this.getActiveWorkspaceRoots(),
      setGlobalStateWritePromise: (promise: Promise<void>) => { this.globalStateWritePromise = promise; },
      emit: (event: "bridge_message", message: unknown) => this.emit(event, message),
      emitBridgeMessage: (message: JsonRecord) => this.emitBridgeMessage(message),
    };
  }

  private createThreadRecordsContext(): ThreadRecordsBridgeContext {
    return {
      sessionSubagentMetadataCache: this.sessionSubagentMetadataCache,
      sessionThreadIndexCache: this.sessionThreadIndexCache,
      sessionSyntheticCollabCallCache: this.sessionSyntheticCollabCallCache,
      getCodexHomePath: () => this.getCodexHomePath(),
      sendLocalRequest: (method: string, params?: unknown) => this.sendLocalRequest(method, params),
    };
  }

  private buildHostConfig(): Record<string, string> {
    return buildRuntimeHostConfig(this.hostId);
  }

  private emitFetchSuccess(requestId: string, body: unknown, status = 200): void {
    emitRuntimeFetchSuccess(this.createRuntimeStateContext(), requestId, body, status);
  }

  private emitFetchError(requestId: string, status: number, error: string): void {
    emitRuntimeFetchError(this.createRuntimeStateContext(), requestId, status, error);
  }

  private emitBridgeMessage(message: JsonRecord): void {
    this.emit("bridge_message", message);
  }

  private scheduleSyntheticCollabHydrationNotifications(method: string | null, payload: unknown): void { scheduleRuntimeSyntheticHydration(this.createRuntimeStateContext(), method, payload); }
  private handleElectronAppStateSnapshotTrigger(message: JsonRecord & { type: string }): void { handleRuntimeAppStateSnapshotTrigger(this.createRuntimeStateContext(), message); }

  private isDroppedBrowserBridgeMessage(message: JsonRecord & { type: string }): boolean {
    if (this.droppedBrowserBridgeMessageTypes.has(message.type)) {
      return true;
    }

    return message.type.endsWith("-response") && typeof message.requestId === "string";
  }

  private async enrichThreadPayloadForMethod(method: string | null, payload: unknown, requestParams?: unknown): Promise<unknown> { return enrichThreadPayloadForMethod(this.createThreadRecordsContext(), method, payload, requestParams); }

  private sendJsonRpcMessage(message: JsonRecord): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async handleLocalJsonRpcRequest(method: string, params: unknown): Promise<{ handled: true; result: unknown } | { handled: false }> { return handleBridgeLocalJsonRpcRequest(this.createLifecycleContext(), method, params); }
  private listExperimentalFeatures(params: unknown): { data: Array<{ name: string; enabled: boolean }>; nextCursor: string | null } { return listBridgeExperimentalFeatures(this.createLifecycleContext(), params); }
  private setExperimentalFeatureEnablement(params: unknown): { name: string; featureName: string; enabled: boolean } { return setBridgeExperimentalFeatureEnablement(this.createLifecycleContext(), params); }

  private getExperimentalFeatureEnablement(): Record<string, boolean> {
    return {
      ...DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT,
      ...normalizeExperimentalFeatureEnablementMap(
        this.globalState.get(EXPERIMENTAL_FEATURES_STATE_KEY),
      ),
    };
  }

  private async sendLocalRequest(method: string, params?: unknown): Promise<unknown> {
    return sendBridgeLocalRequest(this.createLifecycleContext(), method, params);
  }


}
