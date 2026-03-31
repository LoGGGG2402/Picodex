import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import mimeTypes from "mime-types";

import {
  deriveCodexDesktopGlobalStatePath,
  loadCodexDesktopProjects,
} from "./codex-desktop-projects.js";
import { resolveCodexHomePath } from "./codex-home.js";
import {
  DefaultCodexDesktopGitWorkerBridge,
  type CodexDesktopGitWorkerBridge,
} from "./codex-desktop-git-worker.js";
import { debugLog, warnOnceLog } from "./debug.js";
import type { HostBridge, JsonRecord } from "./protocol.js";
import { deriveCodexCliBinaryPath } from "./startup-errors.js";
import {
  derivePersistedAtomRegistryPath,
  loadPersistedAtomRegistry,
  savePersistedAtomRegistry,
} from "./persisted-atom-registry.js";
import {
  deriveGlobalStateRegistryPath,
  loadGlobalStateRegistry,
  saveGlobalStateRegistry,
} from "./global-state-registry.js";
import {
  deriveWorkspaceRootRegistryPath,
  loadWorkspaceRootRegistry,
  saveWorkspaceRootRegistry,
  type WorkspaceRootRegistryState,
} from "./workspace-root-registry.js";
import {
  TerminalSessionManager,
  type TerminalAttachMessage,
  type TerminalCloseMessage,
  type TerminalCreateMessage,
  type TerminalResizeMessage,
  type TerminalRunActionMessage,
  type TerminalWriteMessage,
} from "./terminal-session-manager.js";

interface AppServerBridgeOptions {
  appPath: string;
  appAsarPath?: string;
  codexCliPath?: string;
  cwd: string;
  hostId?: string;
  codexDesktopGlobalStatePath?: string;
  persistedAtomRegistryPath?: string;
  globalStateRegistryPath?: string;
  workspaceRootRegistryPath?: string;
  gitWorkerBridge?: CodexDesktopGitWorkerBridge;
}

interface JsonRpcRequest {
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: unknown;
}

interface AppServerFetchRequest {
  type: "fetch";
  requestId: string;
  method?: string;
  url?: string;
  headers?: unknown;
  body?: unknown;
}

interface AppServerFetchCancel {
  type: "cancel-fetch";
  requestId: string;
}

interface AppServerMcpRequestEnvelope {
  type: "mcp-request";
  request?: JsonRpcRequest;
}

interface AppServerMcpNotificationEnvelope {
  type: "mcp-notification";
  request?: JsonRpcRequest;
}

interface AppServerMcpResponseEnvelope {
  type: "mcp-response";
  response?: JsonRpcResponse;
  message?: JsonRpcResponse;
}

interface TopLevelRequestMessage {
  type: string;
  requestId: string;
}

interface PersistedAtomUpdateMessage {
  type: "persisted-atom-update";
  key?: unknown;
  value?: unknown;
  deleted?: unknown;
}

interface GitOriginRecord {
  dir: string;
  root: string;
  originUrl: string | null;
}

interface GitRepositoryInfo {
  root: string;
  originUrl: string | null;
}

interface GitOriginsResponse {
  origins: GitOriginRecord[];
  homeDir: string;
}

interface FuzzyFileSearchSession {
  roots: string[];
  query: string;
  revision: number;
}

interface SearchableWorkspaceFile {
  absolutePath: string;
  searchablePath: string;
}

interface WorkspaceBrowserRoot {
  path: string;
  label: string;
  active: boolean;
}

interface WorkspaceBrowserEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: "directory" | "file";
}

interface HostBrowserEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

interface WorkspaceBrowserSearchResult {
  root: string;
  path: string;
  relativePath: string;
}

interface PendingLocalRequest {
  method: string;
  params?: unknown;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface SessionSubagentThreadSpawnRecord {
  parent_thread_id: string;
  depth: number | null;
  agent_nickname: string | null;
  agent_role: string | null;
}

interface SessionSubagentMetadata {
  source: {
    subAgent: {
      thread_spawn: SessionSubagentThreadSpawnRecord;
    };
  };
  agentNickname: string | null;
  agentRole: string | null;
}

interface SessionThreadIndexRecord {
  threadId: string;
  parentThreadId: string | null;
  timestamp: number | null;
}

interface SessionSyntheticCollabCallRecord {
  timestampMs: number | null;
  agentId: string;
  agentNickname: string | null;
  agentRole: string | null;
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  tool: string;
  status: "inProgress" | "completed";
  agentStateStatus: "running" | "completed";
  agentStateMessage: string | null;
}

interface ThreadListRequestParams {
  archived: boolean;
  limit: number | null;
  modelProviderSet: Set<string> | null;
  searchTerm: string | null;
  sortKey: "created_at" | "updated_at";
}

interface OpenInTarget {
  id: string;
  label: string;
  icon: string | null;
  available: boolean;
  default?: boolean;
}

interface LocalEnvironmentAction {
  name: string;
  icon?: string;
  command: string;
  platform?: "darwin" | "linux" | "win32";
}

interface LocalEnvironmentDocument {
  version: number;
  name: string;
  setup: {
    script: string;
    darwin?: { script: string };
    linux?: { script: string };
    win32?: { script: string };
  };
  actions: LocalEnvironmentAction[];
}

interface AutoTopUpSettings {
  is_enabled: boolean;
  recharge_threshold: number | null;
  recharge_target: number | null;
}

const MAX_FUZZY_FILE_RESULTS = 200;
const MAX_FUZZY_FILE_CANDIDATES = 10_000;
const MAX_PREVIEW_FILE_BYTES = 1_000_000;
const MAX_PREVIEW_MEDIA_BYTES = 10_000_000;
const CONFIGURATION_STORAGE_PREFIX = "configuration:";
const WORKTREE_CONFIG_VALUE_PREFIX = "worktree-config-value:";
const PREFERRED_OPEN_TARGET_KEY = "preferred-open-target";
const AUTO_TOP_UP_SETTINGS_KEY = "usage-auto-top-up";
const EXPERIMENTAL_FEATURES_STATE_KEY = "experimental-features";
const DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT: Record<string, boolean> = {
  multi_agent: true,
  apps: false,
  plugins: false,
  tool_call_mcp_elicitation: false,
  tool_search: false,
  tool_suggest: false,
};
const DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME = "environment.toml";
const DEFAULT_OPEN_IN_TARGET: OpenInTarget = {
  id: "pocodex-browser",
  label: "Pocodex browser",
  icon: null,
  available: true,
  default: true,
};
const MAX_THREAD_LIST_SUBAGENT_READS = 60;
const IGNORED_FILE_SEARCH_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".svn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);

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
  private readonly sessionSubagentMetadataCache = new Map<
    string,
    Promise<SessionSubagentMetadata | null>
  >();
  private readonly sessionThreadIndexCache = new Map<string, Promise<SessionThreadIndexRecord | null>>();
  private readonly sessionSyntheticCollabCallCache = new Map<
    string,
    Promise<SessionSyntheticCollabCallRecord[]>
  >();
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
  private readonly droppedBrowserBridgeMessageTypes = new Set([
    "copy-conversation-path",
    "copy-working-directory",
    "copy-session-id",
    "copy-deeplink",
    "cancel-fetch-stream",
    "desktop-notification-hide",
    "desktop-notification-show",
    "find-in-thread",
    "hotkey-window-enabled-changed",
    "log-message",
    "navigate-back",
    "navigate-forward",
    "navigate-to-route",
    "new-chat",
    "power-save-blocker-set",
    "rename-thread",
    "serverRequest/resolved",
    "subagent-thread-opened",
    "thread-archived",
    "thread-queued-followups-changed",
    "thread-stream-state-changed",
    "thread-unarchived",
    "toggle-diff-panel",
    "toggle-sidebar",
    "toggle-terminal",
    "toggle-thread-pin",
    "trace-recording-state-changed",
    "trace-recording-uploaded",
    "view-focused",
    "window-fullscreen-changed",
    "electron-set-badge-count",
    "add-context-file",
  ]);
  private readonly localBrowserBridgeHandlers = new Map<
    string,
    (message: JsonRecord & { type: string }) => Promise<void> | void
  >([
    [
      "ready",
      () => {
        this.emitConnectionState();
      },
    ],
    [
      "persisted-atom-sync-request",
      () => {
        this.emit("bridge_message", {
          type: "persisted-atom-sync",
          state: Object.fromEntries(this.persistedAtoms),
        });
      },
    ],
    [
      "persisted-atom-update",
      (message) => {
        this.handlePersistedAtomUpdate(message as unknown as PersistedAtomUpdateMessage);
      },
    ],
    [
      "shared-object-subscribe",
      (message) => {
        this.handleSharedObjectSubscribe(message);
      },
    ],
    [
      "shared-object-unsubscribe",
      (message) => {
        this.handleSharedObjectUnsubscribe(message);
      },
    ],
    [
      "shared-object-set",
      (message) => {
        this.handleSharedObjectSet(message);
      },
    ],
    [
      "archive-thread",
      async (message) => {
        await this.handleThreadArchive(message, "thread/archive");
      },
    ],
    [
      "unarchive-thread",
      async (message) => {
        await this.handleThreadArchive(message, "thread/unarchive");
      },
    ],
    [
      "thread-role-request",
      (message) => {
        this.handleThreadRoleRequest(message as unknown as TopLevelRequestMessage);
      },
    ],
    [
      "electron-onboarding-pick-workspace-or-create-default",
      async () => {
        await this.handleOnboardingPickWorkspaceOrCreateDefault();
      },
    ],
    [
      "electron-onboarding-skip-workspace",
      async () => {
        await this.handleOnboardingSkipWorkspace();
      },
    ],
    [
      "electron-pick-workspace-root-option",
      () => {
        this.openDesktopImportDialog("manual");
      },
    ],
    [
      "electron-add-new-workspace-root-option",
      () => {
        this.openDesktopImportDialog("manual");
      },
    ],
    [
      "electron-update-workspace-root-options",
      async (message) => {
        await this.handleWorkspaceRootsUpdated(message);
      },
    ],
    [
      "electron-set-active-workspace-root",
      async (message) => {
        await this.handleSetActiveWorkspaceRoot(message);
      },
    ],
    [
      "electron-rename-workspace-root-option",
      async (message) => {
        await this.handleRenameWorkspaceRootOption(message);
      },
    ],
    [
      "mcp-request",
      async (message) => {
        await this.handleMcpRequest(message as unknown as AppServerMcpRequestEnvelope);
      },
    ],
    [
      "mcp-notification",
      async (message) => {
        await this.handleMcpNotification(message as unknown as AppServerMcpNotificationEnvelope);
      },
    ],
    [
      "mcp-response",
      async (message) => {
        await this.handleMcpResponse(message as unknown as AppServerMcpResponseEnvelope);
      },
    ],
    [
      "terminal-create",
      async (message) => {
        await this.terminalManager.handleCreate(message as TerminalCreateMessage);
      },
    ],
    [
      "terminal-attach",
      async (message) => {
        await this.terminalManager.handleAttach(message as TerminalAttachMessage);
      },
    ],
    [
      "terminal-write",
      (message) => {
        this.terminalManager.write(message as TerminalWriteMessage);
      },
    ],
    [
      "terminal-run-action",
      (message) => {
        this.terminalManager.runAction(message as TerminalRunActionMessage);
      },
    ],
    [
      "terminal-resize",
      (message) => {
        this.terminalManager.resize(message as TerminalResizeMessage);
      },
    ],
    [
      "terminal-close",
      (message) => {
        this.terminalManager.close(message as TerminalCloseMessage);
      },
    ],
    [
      "fetch",
      async (message) => {
        await this.handleFetchRequest(message as unknown as AppServerFetchRequest);
      },
    ],
    [
      "cancel-fetch",
      (message) => {
        this.handleFetchCancel(message as unknown as AppServerFetchCancel);
      },
    ],
    [
      "fetch-stream",
      (message) => {
        this.emit("bridge_message", {
          type: "fetch-stream-error",
          requestId: typeof message.requestId === "string" ? message.requestId : "",
          error: "Streaming fetch is not supported in Pocodex yet.",
        });
        this.emit("bridge_message", {
          type: "fetch-stream-complete",
          requestId: typeof message.requestId === "string" ? message.requestId : "",
        });
      },
    ],
    [
      "electron-app-state-snapshot-trigger",
      (message) => {
        this.handleElectronAppStateSnapshotTrigger(message);
      },
    ],
  ]);

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
      "browser bridge message has no Pocodex host route and will be dropped",
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
            message: `Worker "${workerName}" is not available in Pocodex yet.`,
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
        case "desktop-workspace-import/list":
          return buildIpcSuccessResponse(
            requestId,
            await this.listDesktopWorkspaceImportCandidates(),
          );
        case "desktop-workspace-import/apply":
          return buildIpcSuccessResponse(
            requestId,
            await this.applyDesktopWorkspaceImports(payload.params),
          );
        case "desktop-workspace-import/add-manual":
          return buildIpcSuccessResponse(
            requestId,
            await this.addManualWorkspaceRoot(payload.params),
          );
        case "desktop-workspace-import/pick-directory":
          return buildIpcSuccessResponse(
            requestId,
            await this.pickDesktopWorkspaceDirectory(payload.params),
          );
        case "desktop-workspace-import/dismiss":
          return buildIpcSuccessResponse(
            requestId,
            await this.dismissDesktopWorkspaceImportPrompt(),
          );
        case "fuzzyFileSearch":
          return buildIpcSuccessResponse(
            requestId,
            await this.handleFuzzyFileSearch(payload.params),
          );
        case "fuzzyFileSearch/sessionStart":
          return buildIpcSuccessResponse(
            requestId,
            await this.startFuzzyFileSearchSession(payload.params),
          );
        case "fuzzyFileSearch/sessionUpdate":
          return buildIpcSuccessResponse(
            requestId,
            await this.updateFuzzyFileSearchSession(payload.params),
          );
        case "fuzzyFileSearch/sessionStop":
          return buildIpcSuccessResponse(
            requestId,
            await this.stopFuzzyFileSearchSession(payload.params),
          );
        case "host-files/resolve":
          return buildIpcSuccessResponse(requestId, await this.resolveHostFiles(payload.params));
        case "host-files/list-directory":
          return buildIpcSuccessResponse(
            requestId,
            await this.listHostDirectory(payload.params),
          );
        case "workspace-files/list-roots":
          return buildIpcSuccessResponse(requestId, await this.listWorkspaceFileRoots());
        case "workspace-files/list-directory":
          return buildIpcSuccessResponse(
            requestId,
            await this.listWorkspaceDirectory(payload.params),
          );
        case "workspace-files/read":
          return buildIpcSuccessResponse(requestId, await this.readWorkspaceFile(payload.params));
        case "workspace-files/search":
          return buildIpcSuccessResponse(
            requestId,
            await this.searchWorkspaceBrowserFiles(payload.params),
          );
        default:
          return buildIpcErrorResponse(
            requestId,
            `IPC method "${method}" is not supported in Pocodex yet.`,
          );
      }
    } catch (error) {
      return buildIpcErrorResponse(
        requestId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private bindProcess(): void {
    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      void this.handleStdoutLine(line);
    });

    const stderr = createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => {
      debugLog("app-server", "stderr", line);
    });

    this.child.on("error", (error) => {
      this.connectionState = "disconnected";
      this.rejectPendingRequests(error);
      this.emit("error", error);
    });

    this.child.once("exit", (code, signal) => {
      this.connectionState = "disconnected";
      this.rejectPendingRequests(
        new Error(
          `Codex app-server exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`,
        ),
      );
      this.emitConnectionState();

      if (this.isClosing) {
        return;
      }

      const error = new Error("Codex app-server exited unexpectedly.");
      this.emit("bridge_message", {
        type: "codex-app-server-fatal-error",
        hostId: this.hostId,
        message: error.message,
      });
      this.emit("error", error);
    });
  }

  private bindGitWorker(): void {
    this.gitWorkerBridge.on("message", (message) => {
      this.emit("worker_message", "git", message);
    });

    this.gitWorkerBridge.on("error", (error) => {
      debugLog("git-worker", "desktop git worker bridge error", {
        error: error.message,
      });
      this.emit("error", error);
    });
  }

  private async initialize(): Promise<void> {
    debugLog("app-server", "starting initialize handshake", {
      hostId: this.hostId,
    });

    await this.sendLocalRequest("initialize", {
      clientInfo: {
        name: "pocodex",
        title: "Pocodex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.sendJsonRpcMessage({
      method: "initialized",
    });

    this.isInitialized = true;
    this.connectionState = "connected";
  }

  private async restoreWorkspaceRootRegistry(): Promise<void> {
    try {
      const loaded = await loadWorkspaceRootRegistry(this.workspaceRootRegistryPath);
      if (loaded.state) {
        this.desktopImportPromptSeen = loaded.state.desktopImportPromptSeen;
        this.applyWorkspaceRootRegistry(loaded.state);
      }
    } catch (error) {
      debugLog("app-server", "failed to restore workspace root registry", {
        error: normalizeError(error).message,
        path: this.workspaceRootRegistryPath,
      });
    }

    this.syncWorkspaceGlobalState();
  }

  private async restorePersistedAtomRegistry(): Promise<void> {
    try {
      const loaded = await loadPersistedAtomRegistry(this.persistedAtomRegistryPath);
      this.persistedAtoms.clear();
      for (const [key, value] of Object.entries(loaded.state)) {
        this.persistedAtoms.set(key, value);
      }
    } catch (error) {
      debugLog("app-server", "failed to restore persisted atoms", {
        error: normalizeError(error).message,
        path: this.persistedAtomRegistryPath,
      });
    }
  }

  private async restoreGlobalStateRegistry(): Promise<void> {
    try {
      const loaded = await loadGlobalStateRegistry(this.globalStateRegistryPath);
      this.globalState.clear();
      for (const [key, value] of Object.entries(loaded.state)) {
        this.globalState.set(key, value);
      }

      const pinnedThreadIds = this.globalState.get("pinned-thread-ids");
      this.pinnedThreadIds.clear();
      if (Array.isArray(pinnedThreadIds)) {
        for (const value of pinnedThreadIds) {
          if (typeof value === "string") {
            this.pinnedThreadIds.add(value);
          }
        }
      }
    } catch (error) {
      debugLog("app-server", "failed to restore global state", {
        error: normalizeError(error).message,
        path: this.globalStateRegistryPath,
      });
    }

    this.syncWorkspaceGlobalState();
  }

  private async listDesktopWorkspaceImportCandidates(): Promise<{
    found: boolean;
    path: string;
    promptSeen: boolean;
    shouldPrompt: boolean;
    projects: Array<{
      root: string;
      label: string;
      activeInCodex: boolean;
      alreadyImported: boolean;
      available: boolean;
    }>;
  }> {
    const loaded = await loadCodexDesktopProjects(this.codexDesktopGlobalStatePath);
    const projects = loaded.projects.map((project) => ({
      root: project.root,
      label: project.label,
      activeInCodex: project.active,
      alreadyImported: this.workspaceRoots.has(project.root),
      available: project.available,
    }));
    const shouldPrompt =
      !this.desktopImportPromptSeen &&
      projects.some((project) => project.available && !project.alreadyImported);

    return {
      found: loaded.found,
      path: loaded.path,
      promptSeen: this.desktopImportPromptSeen,
      shouldPrompt,
      projects,
    };
  }

  private async applyDesktopWorkspaceImports(params: unknown): Promise<{
    importedRoots: string[];
    skippedRoots: string[];
    promptSeen: boolean;
  }> {
    const requestedRoots =
      isJsonRecord(params) && Array.isArray(params.roots) ? uniqueStrings(params.roots) : [];
    const loaded = await loadCodexDesktopProjects(this.codexDesktopGlobalStatePath);
    const importableProjects = new Map(
      loaded.projects
        .filter((project) => project.available)
        .map((project) => [project.root, project] as const),
    );
    const importedRoots: string[] = [];
    const skippedRoots: string[] = [];

    for (const root of requestedRoots) {
      const project = importableProjects.get(root);
      if (!project || this.workspaceRoots.has(root)) {
        skippedRoots.push(root);
        continue;
      }

      this.ensureWorkspaceRoot(root, {
        label: project.label,
        setActive: false,
      });
      importedRoots.push(root);
    }

    this.desktopImportPromptSeen = true;
    await this.persistWorkspaceRootRegistry();

    if (importedRoots.length > 0) {
      this.emitWorkspaceRootsUpdated();
    } else {
      this.syncWorkspaceGlobalState();
    }

    return {
      importedRoots,
      skippedRoots,
      promptSeen: this.desktopImportPromptSeen,
    };
  }

  private async addManualWorkspaceRoot(params: unknown): Promise<{
    addedRoot: string | null;
    promptSeen: boolean;
  }> {
    const requestedRoot =
      isJsonRecord(params) && typeof params.root === "string" ? params.root.trim() : "";
    if (!requestedRoot) {
      throw new Error("Workspace path is required.");
    }

    const resolvedRoot = resolve(requestedRoot);
    let stats;
    try {
      stats = await stat(resolvedRoot);
    } catch {
      throw new Error(`Workspace path does not exist: ${resolvedRoot}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${resolvedRoot}`);
    }

    this.ensureWorkspaceRoot(resolvedRoot, {
      setActive: true,
    });
    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();

    return {
      addedRoot: resolvedRoot,
      promptSeen: this.desktopImportPromptSeen,
    };
  }

  private async pickDesktopWorkspaceDirectory(params: unknown): Promise<{
    pickedRoot: string | null;
  }> {
    const requestedStartPath = isJsonRecord(params) ? normalizeNonEmptyString(params.startPath) : null;
    const pickedRoot = await pickDirectoryOnHost(requestedStartPath ?? this.cwd);
    if (!pickedRoot) {
      return {
        pickedRoot: null,
      };
    }

    const resolvedRoot = resolve(pickedRoot);
    let stats;
    try {
      stats = await stat(resolvedRoot);
    } catch {
      throw new Error(`Workspace path does not exist: ${resolvedRoot}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${resolvedRoot}`);
    }

    return {
      pickedRoot: resolvedRoot,
    };
  }

  private async dismissDesktopWorkspaceImportPrompt(): Promise<{
    promptSeen: boolean;
  }> {
    this.desktopImportPromptSeen = true;
    await this.persistWorkspaceRootRegistry();
    return {
      promptSeen: this.desktopImportPromptSeen,
    };
  }

  private async resolveHostFiles(params: unknown): Promise<{
    files: Array<{
      label: string;
      path: string;
      fsPath: string;
    }>;
  }> {
    const requestedPaths =
      isJsonRecord(params) && Array.isArray(params.paths) ? uniqueStrings(params.paths) : [];
    if (requestedPaths.length === 0) {
      throw new Error("At least one file path is required.");
    }

    const files = [];
    for (const rawPath of requestedPaths) {
      const resolvedPath = resolve(rawPath);
      let stats;
      try {
        stats = await stat(resolvedPath);
      } catch {
        throw new Error(`File path does not exist: ${resolvedPath}`);
      }

      if (!stats.isFile()) {
        throw new Error(`File path is not a file: ${resolvedPath}`);
      }

      files.push({
        label: stripFileExtension(basename(resolvedPath)) || basename(resolvedPath) || "File",
        path: resolvedPath,
        fsPath: resolvedPath,
      });
    }

    return {
      files,
    };
  }

  private async listHostDirectory(params: unknown): Promise<{
    path: string;
    entries: HostBrowserEntry[];
  }> {
    const requestedPath =
      isJsonRecord(params) && typeof params.path === "string" ? params.path.trim() : "";
    const resolvedPath = resolve(requestedPath || homedir());
    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch {
      throw new Error(`Directory does not exist: ${resolvedPath}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedPath}`);
    }

    const entries = await readdir(resolvedPath, { withFileTypes: true });
    const items = entries
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => ({
        name: entry.name,
        path: join(resolvedPath, entry.name),
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null,
      }))
      .filter(
        (
          entry,
        ): entry is {
          name: string;
          path: string;
          kind: "directory" | "file";
        } => entry.kind !== null,
      )
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    return {
      path: resolvedPath,
      entries: items,
    };
  }

  private async handleFuzzyFileSearch(params: unknown): Promise<{
    files: string[];
  }> {
    const query = isJsonRecord(params) && typeof params.query === "string" ? params.query : "";
    const roots = await this.resolveFuzzyFileSearchRoots(
      isJsonRecord(params) ? params.roots : undefined,
    );

    return {
      files: await this.searchWorkspaceFiles(roots, query),
    };
  }

  private async listWorkspaceFileRoots(): Promise<{
    roots: WorkspaceBrowserRoot[];
  }> {
    const roots = await this.resolveWorkspaceBrowserRoots();
    const activeRoot = roots[0] ?? null;

    return {
      roots: roots.map((root) => ({
        path: root,
        label: this.workspaceRootLabels.get(root) ?? (basename(root) || "Workspace"),
        active: root === activeRoot,
      })),
    };
  }

  private async listWorkspaceDirectory(params: unknown): Promise<{
    root: string;
    path: string;
    relativePath: string;
    entries: WorkspaceBrowserEntry[];
  }> {
    const { root, path } = await this.resolveWorkspaceDirectoryRequest(params);
    const entries = await readdir(path, { withFileTypes: true });
    const items = entries
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
        relativePath: relative(root, join(path, entry.name)),
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null,
      }))
      .filter(
        (
          entry,
        ): entry is WorkspaceBrowserEntry & {
          kind: "directory" | "file";
        } => entry.kind !== null,
      )
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    return {
      root,
      path,
      relativePath: relative(root, path) || ".",
      entries: items,
    };
  }

  private async readWorkspaceFile(params: unknown): Promise<{
    root: string;
    path: string;
    relativePath: string;
    kind: "text" | "image" | "pdf" | "binary";
    mimeType: string;
    size: number;
    contents?: string;
    contentsBase64?: string;
  }> {
    const filePath =
      isJsonRecord(params) && typeof params.path === "string" ? params.path.trim() : "";
    if (!filePath) {
      throw new Error("Workspace file path is required.");
    }

    const roots = await this.resolveWorkspaceBrowserRoots();
    const resolvedPath = resolve(filePath);
    const root = roots.find((candidate) => isPathInsideRoot(candidate, resolvedPath));
    if (!root) {
      throw new Error(`Workspace file is outside active roots: ${resolvedPath}`);
    }

    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch {
      throw new Error(`File path does not exist: ${resolvedPath}`);
    }

    if (!stats.isFile()) {
      throw new Error(`File path is not a file: ${resolvedPath}`);
    }

    const detectedMimeType = mimeTypes.lookup(resolvedPath) || "application/octet-stream";
    const isImage = isWorkspacePreviewImageMimeType(detectedMimeType);
    const isPdf = detectedMimeType === "application/pdf";
    const maxPreviewBytes = isImage || isPdf ? MAX_PREVIEW_MEDIA_BYTES : MAX_PREVIEW_FILE_BYTES;
    if (stats.size > maxPreviewBytes) {
      throw new Error(`File is too large to preview: ${resolvedPath}`);
    }

    const contents = await readFile(resolvedPath);

    if (isImage) {
      return {
        root,
        path: resolvedPath,
        relativePath: relative(root, resolvedPath),
        kind: "image",
        mimeType: detectedMimeType,
        size: stats.size,
        contentsBase64: contents.toString("base64"),
      };
    }

    if (isPdf) {
      return {
        root,
        path: resolvedPath,
        relativePath: relative(root, resolvedPath),
        kind: "pdf",
        mimeType: detectedMimeType,
        size: stats.size,
        contentsBase64: contents.toString("base64"),
      };
    }

    if (looksLikeBinaryFile(contents)) {
      return {
        root,
        path: resolvedPath,
        relativePath: relative(root, resolvedPath),
        kind: "binary",
        mimeType: detectedMimeType,
        size: stats.size,
      };
    }

    return {
      root,
      path: resolvedPath,
      relativePath: relative(root, resolvedPath),
      kind: "text",
      mimeType: "text/plain",
      size: stats.size,
      contents: contents.toString("utf8"),
    };
  }

  async resolveWorkspaceFileDownload(filePath: string): Promise<{
    path: string;
    fileName: string;
    mimeType: string;
    size: number;
  }> {
    const requestedPath = filePath.trim();
    if (!requestedPath) {
      throw new Error("Workspace file path is required.");
    }

    const roots = await this.resolveWorkspaceBrowserRoots();
    const resolvedPath = resolve(requestedPath);
    const root = roots.find((candidate) => isPathInsideRoot(candidate, resolvedPath));
    if (!root) {
      throw new Error(`Workspace file is outside active roots: ${resolvedPath}`);
    }

    const fileStats = await stat(resolvedPath).catch(() => {
      throw new Error(`File path does not exist: ${resolvedPath}`);
    });

    if (!fileStats.isFile()) {
      throw new Error(`File path is not a file: ${resolvedPath}`);
    }

    return {
      path: resolvedPath,
      fileName: basename(resolvedPath),
      mimeType: mimeTypes.lookup(resolvedPath) || "application/octet-stream",
      size: fileStats.size,
    };
  }

  private async searchWorkspaceBrowserFiles(params: unknown): Promise<{
    query: string;
    files: WorkspaceBrowserSearchResult[];
  }> {
    const query = isJsonRecord(params) && typeof params.query === "string" ? params.query : "";
    const roots = await this.resolveWorkspaceBrowserRoots();
    const requestedRoot =
      isJsonRecord(params) && typeof params.root === "string" ? resolve(params.root) : "";
    const searchRoots = requestedRoot ? roots.filter((root) => root === requestedRoot) : roots;

    if (requestedRoot && searchRoots.length === 0) {
      throw new Error("Workspace root is not available.");
    }

    const files = await this.searchWorkspaceFiles(searchRoots, query);
    return {
      query,
      files: files.flatMap((filePath) => {
        const root = searchRoots.find((candidate) => isPathInsideRoot(candidate, filePath));
        if (!root) {
          return [];
        }

        return [
          {
            root,
            path: filePath,
            relativePath: relative(root, filePath),
          },
        ];
      }),
    };
  }

  private async startFuzzyFileSearchSession(params: unknown): Promise<{
    sessionId: string;
    roots: string[];
  }> {
    const sessionId =
      isJsonRecord(params) && typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    if (!sessionId) {
      throw new Error("Fuzzy file search session ID is required.");
    }

    const roots = await this.resolveFuzzyFileSearchRoots(
      isJsonRecord(params) ? params.roots : undefined,
    );
    this.fuzzyFileSearchSessions.set(sessionId, {
      roots,
      query: "",
      revision: 0,
    });

    return {
      sessionId,
      roots,
    };
  }

  private async updateFuzzyFileSearchSession(params: unknown): Promise<{
    sessionId: string;
    query: string;
    files: string[];
  }> {
    const sessionId =
      isJsonRecord(params) && typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    if (!sessionId) {
      throw new Error("Fuzzy file search session ID is required.");
    }

    const session = this.fuzzyFileSearchSessions.get(sessionId);
    if (!session) {
      throw new Error("Fuzzy file search session not found.");
    }

    session.query = isJsonRecord(params) && typeof params.query === "string" ? params.query : "";
    session.revision += 1;
    const revision = session.revision;
    const files = await this.searchWorkspaceFiles(session.roots, session.query);
    const latestSession = this.fuzzyFileSearchSessions.get(sessionId);
    if (!latestSession || latestSession.revision !== revision) {
      return {
        sessionId,
        query: session.query,
        files: [],
      };
    }

    this.emitBridgeMessage({
      type: "fuzzyFileSearch/sessionUpdated",
      params: {
        sessionId,
        query: session.query,
        files,
      },
    });
    this.emitBridgeMessage({
      type: "fuzzyFileSearch/sessionCompleted",
      params: {
        sessionId,
        query: session.query,
      },
    });

    return {
      sessionId,
      query: session.query,
      files,
    };
  }

  private async stopFuzzyFileSearchSession(params: unknown): Promise<{
    sessionId: string;
    stopped: boolean;
  }> {
    const sessionId =
      isJsonRecord(params) && typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    if (!sessionId) {
      throw new Error("Fuzzy file search session ID is required.");
    }

    const stopped = this.fuzzyFileSearchSessions.delete(sessionId);
    return {
      sessionId,
      stopped,
    };
  }

  private emitConnectionState(): void {
    this.emit("bridge_message", {
      type: "codex-app-server-connection-changed",
      hostId: this.hostId,
      state: this.connectionState,
      transport: "websocket",
    });

    if (this.isInitialized) {
      this.emit("bridge_message", {
        type: "codex-app-server-initialized",
        hostId: this.hostId,
      });
    }
  }

  private async handleStdoutLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    debugLog("app-server", "stdout", line);

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit(
        "error",
        new Error("Failed to parse Codex app-server output.", {
          cause: error instanceof Error ? error : undefined,
        }),
      );
      return;
    }

    if (!isJsonRecord(message)) {
      return;
    }

    if ("id" in message && !("method" in message)) {
      await this.handleJsonRpcResponse(message);
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }

    if ("id" in message && (typeof message.id === "string" || typeof message.id === "number")) {
      this.emit("bridge_message", {
        type: "mcp-request",
        hostId: this.hostId,
        request: {
          id: message.id,
          method: message.method,
          params: message.params,
        },
      });
      return;
    }

    const params = await this.enrichThreadPayloadForMethod(message.method, message.params);
    this.emit("bridge_message", {
      type: "mcp-notification",
      hostId: this.hostId,
      method: message.method,
      params,
    });
  }

  private async handleJsonRpcResponse(message: JsonRecord): Promise<void> {
    const id =
      typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : null;
    if (id && this.localRequests.has(id)) {
      const pending = this.localRequests.get(id);
      this.localRequests.delete(id);
      if (!pending) {
        return;
      }
      if ("error" in message && message.error !== undefined) {
        pending.reject(
          new Error(extractJsonRpcErrorMessage(message.error), {
            cause: message.error instanceof Error ? message.error : undefined,
          }),
        );
        return;
      }
      pending.resolve(
        await this.enrichThreadPayloadForMethod(pending.method, message.result, pending.params),
      );
      return;
    }

    const method = id ? this.pendingRemoteRequestMethods.get(id) ?? null : null;
    const params = id ? this.pendingRemoteRequestParams.get(id) : undefined;
    if (id) {
      this.pendingRemoteRequestMethods.delete(id);
      this.pendingRemoteRequestParams.delete(id);
    }

    const result =
      message.error !== undefined
        ? undefined
        : await this.enrichThreadPayloadForMethod(method, message.result, params);

    this.emit("bridge_message", {
      type: "mcp-response",
      hostId: this.hostId,
      message: {
        id: message.id,
        ...(message.error !== undefined ? { error: message.error } : { result }),
      },
    });

    if (message.error === undefined) {
      this.scheduleSyntheticCollabHydrationNotifications(method, result);
    }
  }

  private async handleMcpRequest(message: AppServerMcpRequestEnvelope): Promise<void> {
    if (!message.request || typeof message.request.method !== "string") {
      return;
    }

    const localResult = await this.handleLocalJsonRpcRequest(
      message.request.method,
      message.request.params,
    ).catch((error) => {
      if (typeof message.request?.id === "string" || typeof message.request?.id === "number") {
        this.emitBridgeMessage({
          type: "mcp-response",
          hostId: this.hostId,
          message: {
            id: message.request.id,
            error: buildJsonRpcError(-32602, normalizeError(error).message),
          },
        });
      }
      return {
        handled: true as const,
        result: undefined,
      };
    });
    if (localResult.handled) {
      if (
        (typeof message.request.id === "string" || typeof message.request.id === "number") &&
        localResult.result !== undefined
      ) {
        this.emitBridgeMessage({
          type: "mcp-response",
          hostId: this.hostId,
          message: {
            id: message.request.id,
            result: localResult.result,
          },
        });
      }
      return;
    }

    if (typeof message.request.id === "string" || typeof message.request.id === "number") {
      this.pendingRemoteRequestMethods.set(String(message.request.id), message.request.method);
      this.pendingRemoteRequestParams.set(String(message.request.id), message.request.params);
    }

    this.sendJsonRpcMessage({
      id: message.request.id,
      method: message.request.method,
      params: this.sanitizeMcpParams(message.request.method, message.request.params),
    });
  }

  private async handleMcpNotification(message: AppServerMcpNotificationEnvelope): Promise<void> {
    if (!message.request || typeof message.request.method !== "string") {
      return;
    }

    const localResult = await this.handleLocalJsonRpcRequest(
      message.request.method,
      message.request.params,
    );
    if (localResult.handled) {
      return;
    }

    this.sendJsonRpcMessage({
      method: message.request.method,
      params: this.sanitizeMcpParams(message.request.method, message.request.params),
    });
  }

  private async handleMcpResponse(message: AppServerMcpResponseEnvelope): Promise<void> {
    const response = message.response ?? message.message;
    if (!response || (typeof response.id !== "string" && typeof response.id !== "number")) {
      return;
    }

    this.sendJsonRpcMessage({
      id: response.id,
      ...(response.error !== undefined ? { error: response.error } : { result: response.result }),
    });
  }

  private async handleThreadArchive(
    message: JsonRecord,
    method: "thread/archive" | "thread/unarchive",
  ): Promise<void> {
    const conversationId =
      typeof message.conversationId === "string" ? message.conversationId : null;
    if (!conversationId) {
      return;
    }

    try {
      await this.sendLocalRequest(method, {
        threadId: conversationId,
      });
    } catch (error) {
      this.emit("error", normalizeError(error));
    }
  }

  private handleThreadRoleRequest(message: TopLevelRequestMessage): void {
    this.emit("bridge_message", {
      type: "thread-role-response",
      requestId: message.requestId,
      role: "owner",
    });
  }

  private async handleFetchRequest(message: AppServerFetchRequest): Promise<void> {
    if (!message.requestId || !message.url) {
      return;
    }

    const controller = new AbortController();
    this.fetchRequests.set(message.requestId, controller);

    try {
      if (message.url === "vscode://codex/ipc-request") {
        const payload = parseJsonBody(message.body);
        const result = await this.handleIpcRequest(payload);
        this.emitFetchSuccess(message.requestId, result);
        return;
      }

      if (message.url.startsWith("vscode://codex/")) {
        const body = parseJsonBody(message.body);
        const handled = await this.handleCodexFetchRequest(message.url, body);
        if (handled) {
          this.emitFetchSuccess(message.requestId, handled.body, handled.status);
          return;
        }
        this.emitFetchError(
          message.requestId,
          501,
          `Unsupported Codex host fetch URL: ${message.url}`,
        );
        return;
      }

      if (message.url.startsWith("/")) {
        const handled = await this.handleRelativeFetchRequest(
          message.url,
          parseJsonBody(message.body),
        );
        if (handled) {
          this.emitFetchSuccess(message.requestId, handled.body, handled.status);
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

        this.emit("bridge_message", {
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

      this.emit("bridge_message", {
        type: "fetch-response",
        requestId: message.requestId,
        responseType: "success",
        status: response.status,
        headers,
        bodyJsonString: JSON.stringify(parseResponseBody(bodyText)),
      });
    } catch (error) {
      const normalized = normalizeError(error);
      this.emitFetchError(message.requestId, 500, normalized.message);
    } finally {
      this.fetchRequests.delete(message.requestId);
    }
  }

  private handleFetchCancel(message: AppServerFetchCancel): void {
    this.fetchRequests.get(message.requestId)?.abort();
    this.fetchRequests.delete(message.requestId);
  }

  private handlePersistedAtomUpdate(message: PersistedAtomUpdateMessage): void {
    if (typeof message.key !== "string") {
      return;
    }

    if (message.deleted === true) {
      this.persistedAtoms.delete(message.key);
    } else {
      this.persistedAtoms.set(message.key, message.value);
    }

    this.emit("bridge_message", {
      type: "persisted-atom-updated",
      key: message.key,
      value: message.value,
      deleted: message.deleted === true,
    });

    this.queuePersistedAtomRegistryWrite();
  }

  private queuePersistedAtomRegistryWrite(): void {
    const state = Object.fromEntries(this.persistedAtoms);
    this.persistedAtomWritePromise = this.persistedAtomWritePromise
      .catch(() => undefined)
      .then(async () => {
        try {
          await savePersistedAtomRegistry(this.persistedAtomRegistryPath, state);
        } catch (error) {
          debugLog("app-server", "failed to persist persisted atoms", {
            error: normalizeError(error).message,
            path: this.persistedAtomRegistryPath,
          });
        }
      });
  }

  private handleSharedObjectSubscribe(message: JsonRecord): void {
    const key = this.getSharedObjectKey(message);
    if (!key) {
      return;
    }

    this.sharedObjectSubscriptions.add(key);
    this.emitSharedObjectUpdate(key);
  }

  private handleSharedObjectUnsubscribe(message: JsonRecord): void {
    const key = this.getSharedObjectKey(message);
    if (!key) {
      return;
    }

    this.sharedObjectSubscriptions.delete(key);
  }

  private handleSharedObjectSet(message: JsonRecord): void {
    const key = this.getSharedObjectKey(message);
    if (!key) {
      return;
    }

    this.sharedObjects.set(key, message.value ?? null);
    this.emitSharedObjectUpdate(key);
  }

  private async handleOnboardingPickWorkspaceOrCreateDefault(): Promise<void> {
    await this.persistWorkspaceRootRegistry();
    this.emitBridgeMessage({
      type: "electron-onboarding-pick-workspace-or-create-default-result",
      success: true,
    });
  }

  private async handleOnboardingSkipWorkspace(): Promise<void> {
    await this.persistWorkspaceRootRegistry();
    this.emitBridgeMessage({
      type: "electron-onboarding-skip-workspace-result",
      success: true,
    });
  }

  private async handleWorkspaceRootsUpdated(message: JsonRecord): Promise<void> {
    const roots = Array.isArray(message.roots)
      ? message.roots.filter((value): value is string => typeof value === "string")
      : [];
    if (roots.length === 0) {
      this.workspaceRoots.clear();
      this.activeWorkspaceRoot = null;
      await this.persistWorkspaceRootRegistry();
      this.emitWorkspaceRootsUpdated();
      return;
    }

    this.workspaceRoots.clear();
    for (const root of roots) {
      this.workspaceRoots.add(root);
      if (!this.workspaceRootLabels.has(root)) {
        this.workspaceRootLabels.set(root, basename(root) || "Workspace");
      }
    }

    if (!this.activeWorkspaceRoot || !this.workspaceRoots.has(this.activeWorkspaceRoot)) {
      this.activeWorkspaceRoot = roots[0] ?? null;
    }

    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();
  }

  private async handleSetActiveWorkspaceRoot(message: JsonRecord): Promise<void> {
    const root = typeof message.root === "string" ? message.root : null;
    if (!root) {
      return;
    }

    this.ensureWorkspaceRoot(root, { setActive: true });
    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();
  }

  private async handleRenameWorkspaceRootOption(message: JsonRecord): Promise<void> {
    const root = typeof message.root === "string" ? message.root : null;
    if (!root) {
      return;
    }

    const label = typeof message.label === "string" ? message.label.trim() : "";
    if (label) {
      this.workspaceRootLabels.set(root, label);
    } else {
      this.workspaceRootLabels.delete(root);
    }

    await this.persistWorkspaceRootRegistry();
    this.emitBridgeMessage({
      type: "workspace-root-options-updated",
    });
  }

  private async handleCodexFetchRequest(
    rawUrl: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown } | null> {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/^\/+/, "");

    switch (path) {
      case "get-global-state":
        return {
          status: 200,
          body: this.readGlobalState(body),
        };
      case "codex-agents-md":
        return {
          status: 200,
          body: await this.readCodexAgentsDocument(),
        };
      case "codex-agents-md-save":
        return {
          status: 200,
          body: await this.writeCodexAgentsDocument(body),
        };
      case "set-global-state":
        return {
          status: 200,
          body: this.writeGlobalState(body),
        };
      case "list-pinned-threads":
        return {
          status: 200,
          body: {
            threadIds: Array.from(this.pinnedThreadIds),
          },
        };
      case "set-thread-pinned":
        return {
          status: 200,
          body: this.setThreadPinned(body),
        };
      case "set-pinned-threads-order":
        return {
          status: 200,
          body: this.setPinnedThreadsOrder(body),
        };
      case "active-workspace-roots":
        return {
          status: 200,
          body: {
            roots: this.getActiveWorkspaceRoots(),
          },
        };
      case "workspace-root-options":
        return {
          status: 200,
          body: {
            roots: Array.from(this.workspaceRoots),
            labels: Object.fromEntries(this.workspaceRootLabels),
          },
        };
      case "add-workspace-root-option":
        return {
          status: 200,
          body: await this.addWorkspaceRootOption(body),
        };
      case "list-pending-automation-run-threads":
        return {
          status: 200,
          body: {
            threadIds: [],
          },
        };
      case "extension-info":
        return {
          status: 200,
          body: {
            version: "0.1.0",
            buildFlavor: "pocodex",
            buildNumber: "0",
          },
        };
      case "is-copilot-api-available":
        return {
          status: 200,
          body: {
            available: false,
          },
        };
      case "get-copilot-api-proxy-info":
        return {
          status: 200,
          body: {},
        };
      case "mcp-codex-config":
        return {
          status: 200,
          body: await this.readCodexConfig(),
        };
      case "config-value":
        return {
          status: 200,
          body: this.readConfigValue(body),
        };
      case "set-config-value":
        return {
          status: 200,
          body: this.writeConfigValue(body),
        };
      case "developer-instructions":
        return {
          status: 200,
          body: {
            instructions: this.readDeveloperInstructions(body),
          },
        };
      case "os-info":
        return {
          status: 200,
          body: {
            platform: platform(),
            arch: arch(),
            hasWsl: false,
          },
        };
      case "local-environments":
        return {
          status: 200,
          body: await this.listLocalEnvironments(body),
        };
      case "codex-home":
        return {
          status: 200,
          body: {
            codexHome: resolveCodexHomePath(),
          },
        };
      case "list-automations":
        return {
          status: 200,
          body: {
            items: [],
          },
        };
      case "recommended-skills":
        return {
          status: 200,
          body: {
            skills: [],
          },
        };
      case "fast-mode-rollout-metrics":
        return {
          status: 200,
          body: {
            estimatedSavedMs: 0,
            rolloutCountWithCompletedTurns: 0,
          },
        };
      case "has-custom-cli-executable":
        return {
          status: 200,
          body: {
            hasCustomCliExecutable: false,
          },
        };
      case "locale-info":
        return {
          status: 200,
          body: {
            ideLocale: "en-US",
            systemLocale: Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US",
          },
        };
      case "inbox-items":
        return {
          status: 200,
          body: {
            items: [],
          },
        };
      case "open-in-targets":
        return {
          status: 200,
          body: this.readOpenInTargets(),
        };
      case "set-preferred-app":
        return {
          status: 200,
          body: this.writePreferredOpenTarget(body),
        };
      case "gh-cli-status":
        return {
          status: 200,
          body: {
            isInstalled: false,
            isAuthenticated: false,
          },
        };
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
        return {
          status: 200,
          body: {
            ideContext: null,
          },
        };
      case "paths-exist":
        return {
          status: 200,
          body: {
            existingPaths: this.listExistingPaths(body),
          },
        };
      case "read-file-binary":
        return {
          status: 200,
          body: await this.readFileBinary(body),
        };
      case "read-file":
        return {
          status: 200,
          body: await this.readFileText(body),
        };
      case "account-info":
        return {
          status: 200,
          body: {
            accountId: null,
            plan: null,
          },
        };
      case "get-configuration":
        return {
          status: 200,
          body: this.readConfiguration(body),
        };
      case "set-configuration":
        return {
          status: 200,
          body: this.writeConfiguration(body),
        };
      case "terminal-shell-options":
        return {
          status: 200,
          body: this.readTerminalShellOptions(),
        };
      case "local-environment-config":
        return {
          status: 200,
          body: await this.readLocalEnvironmentConfig(body),
        };
      case "local-environment":
        return {
          status: 200,
          body: await this.readLocalEnvironment(body),
        };
      case "local-environment-config-save":
        return {
          status: 200,
          body: await this.writeLocalEnvironmentConfig(body),
        };
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
        return {
          status: 200,
          body: await resolveGitOrigins(body, this.getGitOriginFallbackDirectories()),
        };
      default:
        return null;
    }
  }

  private async handleRelativeFetchRequest(
    url: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown } | null> {
    if (url === "/payments/customer_portal") {
      return {
        status: 200,
        body: {
          url: "https://platform.openai.com/settings/organization/billing/overview",
        },
      };
    }

    if (url.startsWith("/accounts/check/")) {
      return {
        status: 200,
        body: {
          accounts: {},
          account_ordering: [],
        },
      };
    }

    if (url.startsWith("/checkout_pricing_config/configs/")) {
      const currencyCode = decodeURIComponent(url.split("/").at(-1) || "USD").toUpperCase();
      return {
        status: 200,
        body: {
          currency_config: {
            amount_per_credit: 1,
            symbol_code: currencyCode,
            minor_unit_exponent: 2,
          },
        },
      };
    }

    if (url === "/subscriptions/auto_top_up/settings") {
      return {
        status: 200,
        body: this.readAutoTopUpSettings(),
      };
    }

    if (url === "/subscriptions/auto_top_up/enable") {
      return {
        status: 200,
        body: this.updateAutoTopUpSettings(body, {
          enabled: true,
        }),
      };
    }

    if (url === "/subscriptions/auto_top_up/update") {
      return {
        status: 200,
        body: this.updateAutoTopUpSettings(body),
      };
    }

    if (url === "/subscriptions/auto_top_up/disable") {
      return {
        status: 200,
        body: this.updateAutoTopUpSettings(body, {
          enabled: false,
          clearThresholds: true,
        }),
      };
    }

    if (url === "/wham/accounts/check") {
      return {
        status: 200,
        body: {
          accounts: [],
          account_ordering: [],
        },
      };
    }

    if (url === "/wham/environments") {
      return {
        status: 200,
        body: [],
      };
    }

    if (url === "/wham/usage") {
      return {
        status: 200,
        body: {
          credits: null,
          plan_type: null,
          rate_limit: null,
        },
      };
    }

    if (url.startsWith("/wham/tasks/list")) {
      return {
        status: 200,
        body: {
          items: [],
          tasks: [],
          nextCursor: null,
        },
      };
    }

    return null;
  }

  private readGlobalState(body: unknown): Record<string, unknown> {
    const key = isJsonRecord(body) && typeof body.key === "string" ? body.key : null;
    if (!key) {
      return {};
    }

    if (this.globalState.has(key)) {
      return {
        value: this.globalState.get(key),
      };
    }

    if (key === "thread-titles") {
      return {
        value: {},
      };
    }

    return {};
  }

  private readConfiguration(body: unknown): { value: unknown } {
    const key = extractStringParam(body, "key");
    return {
      value: key ? this.getConfigurationValue(key) : null,
    };
  }

  private writeConfiguration(body: unknown): { value: unknown } {
    const key = extractStringParam(body, "key");
    if (!key) {
      return {
        value: null,
      };
    }

    const params = extractFetchParams(body);
    const value = isJsonRecord(params) ? params.value : undefined;
    this.setConfigurationValue(key, value);
    return {
      value,
    };
  }

  private readConfigValue(body: unknown): { value: unknown } {
    const params = extractFetchParams(body);
    const root = extractResolvedPathParam(params, "root");
    const key = isJsonRecord(params) && typeof params.key === "string" ? params.key.trim() : "";
    const scope =
      isJsonRecord(params) && typeof params.scope === "string" ? params.scope.trim() : "worktree";
    if (!root || !key) {
      return {
        value: null,
      };
    }

    return {
      value: this.globalState.get(buildWorktreeConfigStorageKey(root, scope, key)) ?? null,
    };
  }

  private writeConfigValue(body: unknown): Record<string, never> {
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
      this.globalState.delete(storageKey);
    } else {
      this.globalState.set(storageKey, value);
    }
    this.queueGlobalStateRegistryWrite();
    return {};
  }

  private getConfigurationValue(key: string): unknown {
    if (key === "appearanceTheme" && this.globalState.has("appearanceTheme")) {
      return this.globalState.get("appearanceTheme");
    }

    const storedKey = `${CONFIGURATION_STORAGE_PREFIX}${key}`;
    if (this.globalState.has(storedKey)) {
      return this.globalState.get(storedKey);
    }

    switch (key) {
      case "appearanceTheme":
        return "system";
      case "usePointerCursors":
        return false;
      case "sansFontSize":
        return 13;
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

  private setConfigurationValue(key: string, value: unknown): void {
    this.globalState.set(`${CONFIGURATION_STORAGE_PREFIX}${key}`, value ?? null);
    if (key === "appearanceTheme") {
      this.globalState.set("appearanceTheme", value ?? "system");
    }
    this.queueGlobalStateRegistryWrite();
  }

  private readOpenInTargets(): {
    preferredTarget: string;
    targets: OpenInTarget[];
    availableTargets: OpenInTarget[];
  } {
    const stored =
      typeof this.globalState.get(PREFERRED_OPEN_TARGET_KEY) === "string"
        ? (this.globalState.get(PREFERRED_OPEN_TARGET_KEY) as string)
        : null;
    const preferredTarget = stored || DEFAULT_OPEN_IN_TARGET.id;
    const targets = [DEFAULT_OPEN_IN_TARGET];

    return {
      preferredTarget,
      targets,
      availableTargets: targets,
    };
  }

  private writePreferredOpenTarget(body: unknown): { target: string } {
    const target = extractStringParam(body, "target") || DEFAULT_OPEN_IN_TARGET.id;
    this.globalState.set(PREFERRED_OPEN_TARGET_KEY, target);
    this.queueGlobalStateRegistryWrite();
    return {
      target,
    };
  }

  private readTerminalShellOptions(): { availableShells: string[] } {
    if (platform() === "win32") {
      return {
        availableShells: ["powershell", "cmd"],
      };
    }

    return {
      availableShells: [],
    };
  }

  private readAutoTopUpSettings(): AutoTopUpSettings {
    const stored = this.globalState.get(AUTO_TOP_UP_SETTINGS_KEY);
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

  private updateAutoTopUpSettings(
    body: unknown,
    options: { enabled?: boolean; clearThresholds?: boolean } = {},
  ): AutoTopUpSettings & { immediate_top_up_status: null } {
    const next = this.readAutoTopUpSettings();
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

    this.globalState.set(AUTO_TOP_UP_SETTINGS_KEY, next);
    this.queueGlobalStateRegistryWrite();

    return {
      ...next,
      immediate_top_up_status: null,
    };
  }

  private async readCodexConfig(): Promise<unknown> {
    try {
      return await this.sendLocalRequest("config/read", {
        includeLayers: false,
        cwd: this.cwd,
      });
    } catch (error) {
      debugLog("app-server", "failed to read Codex config for host fetch", {
        error: normalizeError(error).message,
      });
      return {
        config: null,
      };
    }
  }

  private async listLocalEnvironments(body: unknown): Promise<{
    environments: Array<
      | {
          configPath: string;
          type: "success";
          environment: LocalEnvironmentDocument;
        }
      | {
          configPath: string;
          type: "error";
          error: { message: string };
        }
    >;
  }> {
    const workspaceRoot = extractResolvedPathParam(extractFetchParams(body), "workspaceRoot");
    if (!workspaceRoot) {
      return {
        environments: [],
      };
    }

    const configPaths = await this.listLocalEnvironmentConfigPaths(workspaceRoot);
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
            error: {
              message: normalizeError(error).message,
            },
          };
        }
      }),
    );

    return {
      environments,
    };
  }

  private async readLocalEnvironmentConfig(body: unknown): Promise<{
    configPath: string;
    exists: boolean;
  }> {
    const configPath = await this.resolveLocalEnvironmentConfigPathFromBody(body);
    return {
      configPath,
      exists: existsSync(configPath),
    };
  }

  private async readLocalEnvironment(body: unknown): Promise<{
    environment:
      | {
          type: "success";
          environment: LocalEnvironmentDocument;
        }
      | {
          type: "error";
          error: { message: string };
        };
  }> {
    const configPath = await this.resolveLocalEnvironmentConfigPathFromBody(body);
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
          error: {
            message: normalizeError(error).message,
          },
        },
      };
    }
  }

  private async writeLocalEnvironmentConfig(body: unknown): Promise<{
    configPath: string;
  }> {
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

    return {
      configPath,
    };
  }

  private async resolveLocalEnvironmentConfigPathFromBody(body: unknown): Promise<string> {
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

  private async listLocalEnvironmentConfigPaths(workspaceRoot: string): Promise<string[]> {
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

  private readDeveloperInstructions(body: unknown): string | null {
    if (!isJsonRecord(body)) {
      return null;
    }

    const params = isJsonRecord(body.params) ? body.params : body;
    return typeof params.baseInstructions === "string" ? params.baseInstructions : null;
  }

  private getCodexHomePath(): string {
    return resolveCodexHomePath();
  }

  private getCodexAgentsDocumentPath(): string {
    return join(this.getCodexHomePath(), "AGENTS.md");
  }

  private async readCodexAgentsDocument(): Promise<{
    path: string;
    contents: string;
  }> {
    const documentPath = this.getCodexAgentsDocumentPath();
    let stats;
    try {
      stats = await stat(documentPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          path: documentPath,
          contents: "",
        };
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

    return {
      path: documentPath,
      contents: contents.toString("utf8"),
    };
  }

  private async writeCodexAgentsDocument(body: unknown): Promise<{
    path: string;
  }> {
    const params = isJsonRecord(body) && isJsonRecord(body.params) ? body.params : body;
    const contents =
      isJsonRecord(params) && typeof params.contents === "string" ? params.contents : null;
    if (contents === null) {
      throw new Error("AGENTS.md contents are required.");
    }

    const documentPath = this.getCodexAgentsDocumentPath();
    await mkdir(dirname(documentPath), { recursive: true });
    await writeFile(documentPath, contents, "utf8");

    return {
      path: documentPath,
    };
  }

  private async readFileBinary(body: unknown): Promise<{
    contentsBase64: string;
  }> {
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
    return {
      contentsBase64: contents.toString("base64"),
    };
  }

  private async readFileText(body: unknown): Promise<{
    contents: string;
  }> {
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

    return {
      contents: contents.toString("utf8"),
    };
  }

  private async resolveFuzzyFileSearchRoots(rawRoots: unknown): Promise<string[]> {
    const requestedRoots = Array.isArray(rawRoots) ? uniqueStrings(rawRoots) : [];
    const candidateRoots =
      requestedRoots.length > 0 ? requestedRoots : this.getActiveWorkspaceRoots();
    const roots = candidateRoots.length > 0 ? candidateRoots : [this.cwd];
    const resolvedRoots: string[] = [];

    for (const root of roots) {
      const resolvedRoot = resolve(root);
      let stats;
      try {
        stats = await stat(resolvedRoot);
      } catch {
        continue;
      }

      if (!stats.isDirectory()) {
        continue;
      }

      resolvedRoots.push(resolvedRoot);
    }

    if (resolvedRoots.length === 0) {
      throw new Error("No workspace roots are available for file search.");
    }

    return uniqueStrings(resolvedRoots);
  }

  private async resolveWorkspaceBrowserRoots(): Promise<string[]> {
    const candidateRoots = this.getActiveWorkspaceRoots();
    const roots = candidateRoots.length > 0 ? candidateRoots : [this.cwd];
    const resolvedRoots: string[] = [];

    for (const root of roots) {
      const resolvedRoot = resolve(root);
      let stats;
      try {
        stats = await stat(resolvedRoot);
      } catch {
        continue;
      }

      if (!stats.isDirectory()) {
        continue;
      }

      resolvedRoots.push(resolvedRoot);
    }

    if (resolvedRoots.length === 0) {
      throw new Error("No workspace roots are available.");
    }

    return uniqueStrings(resolvedRoots);
  }

  private async resolveWorkspaceDirectoryRequest(params: unknown): Promise<{
    root: string;
    path: string;
  }> {
    const roots = await this.resolveWorkspaceBrowserRoots();
    const requestedRoot =
      isJsonRecord(params) && typeof params.root === "string" ? params.root.trim() : "";
    const requestedPath =
      isJsonRecord(params) && typeof params.path === "string" ? params.path.trim() : "";
    const root = requestedRoot ? resolve(requestedRoot) : roots[0];

    if (!root || !roots.includes(root)) {
      throw new Error("Workspace root is not available.");
    }

    const path = requestedPath ? resolve(requestedPath) : root;
    if (!isPathInsideRoot(root, path)) {
      throw new Error(`Workspace directory is outside root: ${path}`);
    }

    let stats;
    try {
      stats = await stat(path);
    } catch {
      throw new Error(`Workspace directory does not exist: ${path}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${path}`);
    }

    return { root, path };
  }

  private async searchWorkspaceFiles(roots: string[], query: string): Promise<string[]> {
    const candidates = await this.listWorkspaceFiles(roots);
    return rankWorkspaceFiles(candidates, query, MAX_FUZZY_FILE_RESULTS);
  }

  private async listWorkspaceFiles(roots: string[]): Promise<SearchableWorkspaceFile[]> {
    const ripgrepFiles = await this.listWorkspaceFilesWithRipgrep(roots);
    if (ripgrepFiles) {
      return ripgrepFiles;
    }

    return this.listWorkspaceFilesWithDirectoryWalk(roots);
  }

  private async listWorkspaceFilesWithRipgrep(
    roots: string[],
  ): Promise<SearchableWorkspaceFile[] | null> {
    try {
      const files: SearchableWorkspaceFile[] = [];
      const seen = new Set<string>();
      const includeRootName = roots.length > 1;

      for (const root of roots) {
        const stdout = await execFileText(
          "rg",
          [
            "--files",
            "--hidden",
            "--glob",
            "!.git",
            "--glob",
            "!node_modules",
            "--glob",
            "!dist",
            "--glob",
            "!coverage",
            ".",
          ],
          root,
        );

        const rootLabel = basename(root);
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === ".") {
            continue;
          }

          const absolutePath = resolve(root, trimmed);
          if (seen.has(absolutePath)) {
            continue;
          }

          seen.add(absolutePath);
          files.push({
            absolutePath,
            searchablePath: buildSearchableWorkspacePath({
              absolutePath,
              root,
              rootLabel,
              includeRootName,
            }),
          });
          if (files.length >= MAX_FUZZY_FILE_CANDIDATES) {
            return files;
          }
        }
      }

      return files;
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.message.includes("ENOENT")) {
        return null;
      }
      debugLog("app-server", "ripgrep file search failed, falling back to directory walk", {
        error: normalized.message,
      });
      return null;
    }
  }

  private async listWorkspaceFilesWithDirectoryWalk(
    roots: string[],
  ): Promise<SearchableWorkspaceFile[]> {
    const files: SearchableWorkspaceFile[] = [];
    const seen = new Set<string>();
    const includeRootName = roots.length > 1;

    for (const root of roots) {
      const rootLabel = basename(root);
      const queue = [root];

      while (queue.length > 0) {
        const currentDirectory = queue.shift();
        if (!currentDirectory) {
          continue;
        }

        let entries;
        try {
          entries = await readdir(currentDirectory, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          const absolutePath = join(currentDirectory, entry.name);

          if (entry.isSymbolicLink()) {
            continue;
          }

          if (entry.isDirectory()) {
            if (IGNORED_FILE_SEARCH_DIRECTORIES.has(entry.name)) {
              continue;
            }
            queue.push(absolutePath);
            continue;
          }

          if (!entry.isFile() || seen.has(absolutePath)) {
            continue;
          }

          seen.add(absolutePath);
          files.push({
            absolutePath,
            searchablePath: buildSearchableWorkspacePath({
              absolutePath,
              root,
              rootLabel,
              includeRootName,
            }),
          });
          if (files.length >= MAX_FUZZY_FILE_CANDIDATES) {
            return files;
          }
        }
      }
    }

    return files;
  }

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

  private sanitizeThreadStartParams(params: JsonRecord): JsonRecord {
    const sanitized: JsonRecord = {
      ...params,
    };
    const config = isJsonRecord(params.config) ? params.config : null;

    if (typeof sanitized.model !== "string" && config && typeof config.model === "string") {
      sanitized.model = config.model;
    }

    delete sanitized.config;
    delete sanitized.modelProvider;

    return sanitized;
  }

  private sanitizeThreadResumeParams(params: JsonRecord): JsonRecord {
    const sanitized: JsonRecord = {
      ...params,
    };
    const config = isJsonRecord(params.config) ? params.config : null;

    if (typeof sanitized.model !== "string" && config && typeof config.model === "string") {
      sanitized.model = config.model;
    }

    delete sanitized.config;
    delete sanitized.modelProvider;

    return sanitized;
  }

  private writeGlobalState(body: unknown): Record<string, never> {
    if (!isJsonRecord(body) || typeof body.key !== "string") {
      return {};
    }

    this.globalState.set(body.key, body.value);
    if (body.key === "pinned-thread-ids" && Array.isArray(body.value)) {
      this.pinnedThreadIds.clear();
      for (const value of body.value) {
        if (typeof value === "string") {
          this.pinnedThreadIds.add(value);
        }
      }
      this.emitBridgeMessage({
        type: "pinned-threads-updated",
      });
    }

    this.queueGlobalStateRegistryWrite();
    return {};
  }

  private setThreadPinned(body: unknown): Record<string, never> {
    if (!isJsonRecord(body)) {
      return {};
    }

    const threadId =
      typeof body.threadId === "string"
        ? body.threadId
        : typeof body.conversationId === "string"
          ? body.conversationId
          : null;
    if (!threadId) {
      return {};
    }

    if (body.pinned === false) {
      this.pinnedThreadIds.delete(threadId);
    } else {
      this.pinnedThreadIds.add(threadId);
    }

    this.globalState.set("pinned-thread-ids", Array.from(this.pinnedThreadIds));
    this.queueGlobalStateRegistryWrite();
    this.emitBridgeMessage({
      type: "pinned-threads-updated",
    });
    return {};
  }

  private setPinnedThreadsOrder(body: unknown): Record<string, never> {
    if (!isJsonRecord(body) || !Array.isArray(body.threadIds)) {
      return {};
    }

    const ordered = body.threadIds.filter((value): value is string => typeof value === "string");
    const remaining = Array.from(this.pinnedThreadIds).filter(
      (threadId) => !ordered.includes(threadId),
    );

    this.pinnedThreadIds.clear();
    for (const threadId of [...ordered, ...remaining]) {
      this.pinnedThreadIds.add(threadId);
    }

    this.globalState.set("pinned-thread-ids", Array.from(this.pinnedThreadIds));
    this.queueGlobalStateRegistryWrite();
    this.emitBridgeMessage({
      type: "pinned-threads-updated",
    });
    return {};
  }

  private async addWorkspaceRootOption(body: unknown): Promise<{ success: boolean; root: string }> {
    const root = isJsonRecord(body) && typeof body.root === "string" ? body.root : null;
    const label = isJsonRecord(body) && typeof body.label === "string" ? body.label : null;
    const setActive = !isJsonRecord(body) || body.setActive !== false;

    if (!root) {
      this.openDesktopImportDialog("manual");
      return {
        success: false,
        root: "",
      };
    }

    this.ensureWorkspaceRoot(root, {
      label,
      setActive,
    });
    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();
    return {
      success: true,
      root,
    };
  }

  private applyWorkspaceRootRegistry(state: WorkspaceRootRegistryState): void {
    this.workspaceRoots.clear();
    this.workspaceRootLabels.clear();
    this.desktopImportPromptSeen = state.desktopImportPromptSeen;

    for (const root of state.roots) {
      this.workspaceRoots.add(root);
      const label = state.labels[root]?.trim();
      this.workspaceRootLabels.set(root, label || basename(root) || "Workspace");
    }

    this.activeWorkspaceRoot =
      state.activeRoot && this.workspaceRoots.has(state.activeRoot)
        ? state.activeRoot
        : (state.roots[0] ?? null);
  }

  private async persistWorkspaceRootRegistry(): Promise<void> {
    const roots = Array.from(this.workspaceRoots);
    try {
      const labels = Object.fromEntries(
        roots.flatMap((root) => {
          const label = this.workspaceRootLabels.get(root)?.trim();
          return label ? [[root, label] as const] : [];
        }),
      );
      await saveWorkspaceRootRegistry(this.workspaceRootRegistryPath, {
        roots,
        labels,
        activeRoot:
          this.activeWorkspaceRoot && this.workspaceRoots.has(this.activeWorkspaceRoot)
            ? this.activeWorkspaceRoot
            : (roots[0] ?? null),
        desktopImportPromptSeen: this.desktopImportPromptSeen,
      });
    } catch (error) {
      debugLog("app-server", "failed to persist workspace root registry", {
        error: normalizeError(error).message,
        path: this.workspaceRootRegistryPath,
      });
    }
  }

  private ensureWorkspaceRoot(
    root: string,
    options: { label?: string | null; setActive?: boolean } = {},
  ): void {
    this.workspaceRoots.add(root);
    const label = options.label?.trim();
    if (label) {
      this.workspaceRootLabels.set(root, label);
    } else if (!this.workspaceRootLabels.has(root)) {
      this.workspaceRootLabels.set(root, basename(root) || "Workspace");
    }

    if (options.setActive !== false) {
      this.activeWorkspaceRoot = root;
    }
  }

  private emitWorkspaceRootsUpdated(): void {
    this.syncWorkspaceGlobalState();
    this.emitBridgeMessage({
      type: "workspace-root-options-updated",
    });
    this.emitBridgeMessage({
      type: "active-workspace-roots-updated",
    });
  }

  private syncWorkspaceGlobalState(): void {
    this.globalState.set("pinned-thread-ids", Array.from(this.pinnedThreadIds));
    this.globalState.set("active-workspace-roots", this.getActiveWorkspaceRoots());
    this.queueGlobalStateRegistryWrite();
  }

  private queueGlobalStateRegistryWrite(): void {
    const state = Object.fromEntries(this.globalState);
    this.globalStateWritePromise = this.globalStateWritePromise
      .catch(() => undefined)
      .then(async () => {
        try {
          await saveGlobalStateRegistry(this.globalStateRegistryPath, state);
        } catch (error) {
          debugLog("app-server", "failed to persist global state", {
            error: normalizeError(error).message,
            path: this.globalStateRegistryPath,
          });
        }
      });
  }

  private getActiveWorkspaceRoots(): string[] {
    const roots = Array.from(this.workspaceRoots);
    if (roots.length === 0) {
      return [];
    }

    if (this.activeWorkspaceRoot && this.workspaceRoots.has(this.activeWorkspaceRoot)) {
      return [
        this.activeWorkspaceRoot,
        ...roots.filter((root) => root !== this.activeWorkspaceRoot),
      ];
    }

    return roots;
  }

  private getGitOriginFallbackDirectories(): string[] {
    const activeRoots = this.getActiveWorkspaceRoots();
    if (activeRoots.length > 0) {
      return activeRoots;
    }

    return this.cwd.length > 0 ? [this.cwd] : [];
  }

  private openDesktopImportDialog(mode: "first-run" | "manual"): void {
    this.emitBridgeMessage({
      type: "pocodex-open-desktop-import-dialog",
      mode,
    });
  }

  private getSharedObjectKey(message: JsonRecord): string | null {
    const candidates = [message.key, message.name, message.objectKey, message.objectName];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
    return null;
  }

  private emitSharedObjectUpdate(key: string): void {
    const value = this.sharedObjects.has(key) ? this.sharedObjects.get(key) : null;
    this.emitBridgeMessage({
      type: "shared-object-updated",
      key,
      value,
    });
  }

  private buildHostConfig(): Record<string, string> {
    return {
      id: this.hostId,
      display_name: "Local",
      kind: "local",
    };
  }

  private emitFetchSuccess(requestId: string, body: unknown, status = 200): void {
    this.emit("bridge_message", {
      type: "fetch-response",
      requestId,
      responseType: "success",
      status,
      headers: {
        "content-type": "application/json",
      },
      bodyJsonString: JSON.stringify(body),
    });
  }

  private emitFetchError(requestId: string, status: number, error: string): void {
    this.emit("bridge_message", {
      type: "fetch-response",
      requestId,
      responseType: "error",
      status,
      error,
    });
  }

  private emitBridgeMessage(message: JsonRecord): void {
    this.emit("bridge_message", message);
  }

  private scheduleSyntheticCollabHydrationNotifications(
    method: string | null,
    payload: unknown,
  ): void {
    if (method !== "thread/read" && method !== "thread/resume") {
      return;
    }

    const thread = isJsonRecord(payload) && isJsonRecord(payload.thread) ? payload.thread : null;
    if (!thread || typeof thread.id !== "string" || !Array.isArray(thread.turns)) {
      return;
    }

    const notifications: Array<{
      threadId: string;
      turnId: string;
      item: JsonRecord;
    }> = [];
    for (const turn of thread.turns) {
      if (!isJsonRecord(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items)) {
        continue;
      }

      for (const item of turn.items) {
        if (
          !isJsonRecord(item) ||
          item.type !== "collabAgentToolCall" ||
          typeof item.id !== "string" ||
          !Array.isArray(item.receiverThreadIds) ||
          item.receiverThreadIds.length === 0
        ) {
          continue;
        }

        notifications.push({
          threadId: thread.id,
          turnId: turn.id,
          item,
        });
      }
    }

    if (notifications.length === 0) {
      return;
    }

    // The renderer only hydrates receiver threads from item notifications, but it
    // builds the conversation state from the thread/read or thread/resume result
    // asynchronously. Emit a few deferred retries so the notification lands after
    // the conversation exists in the client-side store.
    const retryDelaysMs = [0, 50, 250, 1000];
    for (const delayMs of retryDelaysMs) {
      const timer = setTimeout(() => {
        this.syntheticCollabHydrationTimers.delete(timer);
        if (this.isClosing) {
          return;
        }

        for (const notification of notifications) {
          this.emitBridgeMessage({
            type: "mcp-notification",
            hostId: this.hostId,
            method: "item/completed",
            params: {
              threadId: notification.threadId,
              turnId: notification.turnId,
              item: notification.item,
            },
          });
        }
      }, delayMs);
      this.syntheticCollabHydrationTimers.add(timer);
    }

    debugLog("app-server", "scheduled synthetic collab hydration notifications", {
      method,
      threadId: thread.id,
      notificationCount: notifications.length,
      retryDelaysMs,
    });
  }

  private handleElectronAppStateSnapshotTrigger(message: JsonRecord & { type: string }): void {
    const reason = normalizeNonEmptyString(message.reason) ?? "pocodex-bridge";
    const requestId = `pocodex-app-state-snapshot-${randomUUID()}`;

    debugLog("app-server", "bridging app state snapshot trigger", {
      requestId,
      reason,
    });

    this.emitBridgeMessage({
      type: "electron-app-state-snapshot-request",
      hostId: this.hostId,
      requestId,
      reason,
    });
  }

  private isDroppedBrowserBridgeMessage(message: JsonRecord & { type: string }): boolean {
    if (this.droppedBrowserBridgeMessageTypes.has(message.type)) {
      return true;
    }

    return message.type.endsWith("-response") && typeof message.requestId === "string";
  }

  private async enrichThreadPayloadForMethod(
    method: string | null,
    payload: unknown,
    requestParams?: unknown,
  ): Promise<unknown> {
    if (!method?.startsWith("thread/")) {
      return payload;
    }

    if (Array.isArray(payload)) {
      return Promise.all(
        payload.map((item) => this.enrichThreadPayloadForMethod(method, item, requestParams)),
      );
    }

    if (!isJsonRecord(payload)) {
      return payload;
    }

    const maybeThreadRecord = await this.enrichThreadRecord(payload);
    if (maybeThreadRecord !== payload) {
      return maybeThreadRecord;
    }

    let changed = false;
    const nextPayload: JsonRecord = { ...payload };

    if (Array.isArray(payload.data)) {
      const enrichedData = await Promise.all(payload.data.map((item) => this.enrichThreadRecord(item)));
      if (!arraysReferenceEqual(payload.data, enrichedData)) {
        nextPayload.data = enrichedData;
        changed = true;
      }
    }

    if (Array.isArray(payload.threads)) {
      const enrichedThreads = await Promise.all(
        payload.threads.map((item) => this.enrichThreadRecord(item)),
      );
      if (!arraysReferenceEqual(payload.threads, enrichedThreads)) {
        nextPayload.threads = enrichedThreads;
        changed = true;
      }
    }

    if (isJsonRecord(payload.thread)) {
      const enrichedThread = await this.enrichThreadRecord(payload.thread);
      if (enrichedThread !== payload.thread) {
        nextPayload.thread = enrichedThread;
        changed = true;
      }
    }

    if (isJsonRecord(payload.conversation)) {
      const enrichedConversation = await this.enrichThreadRecord(payload.conversation);
      if (enrichedConversation !== payload.conversation) {
        nextPayload.conversation = enrichedConversation;
        changed = true;
      }
    }

    const enrichedPayload = changed ? nextPayload : payload;
    if (method === "thread/list") {
      return this.augmentThreadListPayload(enrichedPayload, requestParams);
    }

    return enrichedPayload;
  }

  private async enrichThreadRecord(payload: unknown): Promise<unknown> {
    if (!isJsonRecord(payload)) {
      return payload;
    }

    const threadPath = extractThreadSessionPath(payload);
    if (!threadPath) {
      return payload;
    }

    let changed = false;
    const nextPayload: JsonRecord = { ...payload };

    if (!hasSubagentThreadSource(payload.source)) {
      const metadata = await this.readSessionSubagentMetadata(threadPath);
      if (metadata) {
        nextPayload.source = metadata.source;
        changed = true;

        if (!hasNonEmptyString(payload.agentNickname) && metadata.agentNickname !== null) {
          nextPayload.agentNickname = metadata.agentNickname;
        }

        if (!hasNonEmptyString(payload.agentRole) && metadata.agentRole !== null) {
          nextPayload.agentRole = metadata.agentRole;
        }
      }
    }

    if (Array.isArray(payload.turns) && typeof payload.id === "string") {
      const syntheticCollabCalls = await this.readSessionSyntheticCollabCalls(threadPath);
      const enrichedTurns = injectSyntheticCollabToolCalls(payload.turns, payload.id, syntheticCollabCalls);
      if (!arraysReferenceEqual(payload.turns, enrichedTurns)) {
        nextPayload.turns = enrichedTurns;
        changed = true;
        debugLog("app-server", "injected synthetic collab tool calls", {
          threadId: payload.id,
          sessionPath: threadPath,
          syntheticCollabCallCount: syntheticCollabCalls.length,
        });
      }
    }

    return changed ? nextPayload : payload;
  }

  private async readSessionSubagentMetadata(
    threadPath: string,
  ): Promise<SessionSubagentMetadata | null> {
    const normalizedPath = resolve(threadPath);
    const cached = this.sessionSubagentMetadataCache.get(normalizedPath);
    if (cached) {
      return cached;
    }

    const pending = this.loadSessionSubagentMetadata(normalizedPath);
    this.sessionSubagentMetadataCache.set(normalizedPath, pending);
    return pending;
  }

  private async readSessionSyntheticCollabCalls(
    threadPath: string,
  ): Promise<SessionSyntheticCollabCallRecord[]> {
    const normalizedPath = resolve(threadPath);
    const cached = this.sessionSyntheticCollabCallCache.get(normalizedPath);
    if (cached) {
      return cached;
    }

    const pending = this.loadSessionSyntheticCollabCalls(normalizedPath);
    this.sessionSyntheticCollabCallCache.set(normalizedPath, pending);
    return pending;
  }

  private async augmentThreadListPayload(
    payload: unknown,
    requestParams: unknown,
  ): Promise<unknown> {
    if (!isJsonRecord(payload) || !Array.isArray(payload.data)) {
      return payload;
    }

    const params = normalizeThreadListRequestParams(requestParams);
    const existingIds = new Set<string>();
    for (const item of payload.data) {
      if (isJsonRecord(item) && typeof item.id === "string") {
        existingIds.add(item.id);
      }
    }

    const indexedSessions = await this.listIndexedSubagentSessions(params.archived);
    const missingCandidates = indexedSessions
      .filter((record) => !existingIds.has(record.threadId))
      .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
      .slice(
        0,
        Math.max(
          params.limit ?? MAX_THREAD_LIST_SUBAGENT_READS,
          MAX_THREAD_LIST_SUBAGENT_READS,
        ),
      );

    if (missingCandidates.length === 0) {
      return payload;
    }

    const supplementalThreads: JsonRecord[] = [];
    for (const candidate of missingCandidates) {
      const thread = await this.readThreadRecordById(candidate.threadId);
      if (!thread || existingIds.has(candidate.threadId)) {
        continue;
      }
      if (!matchesThreadListFilters(thread, params)) {
        continue;
      }
      supplementalThreads.push(thread);
      existingIds.add(candidate.threadId);
    }

    if (supplementalThreads.length === 0) {
      return payload;
    }

    debugLog("app-server", "supplemented thread/list with indexed subagent threads", {
      supplementalThreadCount: supplementalThreads.length,
      supplementalThreadIds: supplementalThreads
        .map((thread) => normalizeNonEmptyString(thread.id))
        .filter((threadId): threadId is string => threadId !== null),
    });

    const mergedThreads = [...payload.data, ...supplementalThreads].sort((left, right) =>
      compareThreadListRecords(left, right, params.sortKey),
    );
    const limitedThreads =
      params.limit !== null && mergedThreads.length > params.limit
        ? mergedThreads.slice(0, params.limit)
        : mergedThreads;

    if (arraysReferenceEqual(payload.data, limitedThreads)) {
      return payload;
    }

    return {
      ...payload,
      data: limitedThreads,
    };
  }

  private async listIndexedSubagentSessions(archived: boolean): Promise<SessionThreadIndexRecord[]> {
    const sessionsRoot = join(this.getCodexHomePath(), archived ? "archived_sessions" : "sessions");
    const queue = [sessionsRoot];
    const indexedSessions: SessionThreadIndexRecord[] = [];

    while (queue.length > 0) {
      const currentDirectory = queue.shift();
      if (!currentDirectory) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(currentDirectory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absolutePath = join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          queue.push(absolutePath);
          continue;
        }

        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }

        const indexedSession = await this.readSessionThreadIndexRecord(absolutePath);
        if (!indexedSession?.parentThreadId) {
          continue;
        }

        indexedSessions.push(indexedSession);
      }
    }

    return indexedSessions;
  }

  private async readSessionThreadIndexRecord(
    sessionPath: string,
  ): Promise<SessionThreadIndexRecord | null> {
    const normalizedPath = resolve(sessionPath);
    const cached = this.sessionThreadIndexCache.get(normalizedPath);
    if (cached) {
      return cached;
    }

    const pending = this.loadSessionThreadIndexRecord(normalizedPath);
    this.sessionThreadIndexCache.set(normalizedPath, pending);
    return pending;
  }

  private async loadSessionThreadIndexRecord(
    sessionPath: string,
  ): Promise<SessionThreadIndexRecord | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(sessionPath, "r");
      const chunks: string[] = [];
      let position = 0;
      let totalBytesRead = 0;

      while (totalBytesRead < 256 * 1024) {
        const buffer = Buffer.alloc(16 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) {
          break;
        }

        totalBytesRead += bytesRead;
        position += bytesRead;

        const chunk = buffer.toString("utf8", 0, bytesRead);
        const newlineIndex = chunk.indexOf("\n");
        if (newlineIndex >= 0) {
          chunks.push(chunk.slice(0, newlineIndex));
          break;
        }

        chunks.push(chunk);
      }

      const firstLine = chunks.join("").trim();
      if (!firstLine) {
        return null;
      }

      return parseSessionThreadIndexRecord(JSON.parse(firstLine));
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      debugLog("app-server", "failed to read session thread index record", {
        path: sessionPath,
        error: normalizeError(error).message,
      });
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readThreadRecordById(threadId: string): Promise<JsonRecord | null> {
    try {
      const response = await this.sendLocalRequest("thread/read", {
        threadId,
        includeTurns: false,
      });
      if (!isJsonRecord(response) || !isJsonRecord(response.thread)) {
        return null;
      }
      return response.thread;
    } catch {
      return null;
    }
  }

  private async loadSessionSubagentMetadata(
    sessionPath: string,
  ): Promise<SessionSubagentMetadata | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(sessionPath, "r");
      const chunks: string[] = [];
      let position = 0;
      let totalBytesRead = 0;

      while (totalBytesRead < 256 * 1024) {
        const buffer = Buffer.alloc(16 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) {
          break;
        }

        totalBytesRead += bytesRead;
        position += bytesRead;

        const chunk = buffer.toString("utf8", 0, bytesRead);
        const newlineIndex = chunk.indexOf("\n");
        if (newlineIndex >= 0) {
          chunks.push(chunk.slice(0, newlineIndex));
          break;
        }

        chunks.push(chunk);
      }

      const firstLine = chunks.join("").trim();
      if (!firstLine) {
        return null;
      }

      return parseSessionSubagentMetadata(JSON.parse(firstLine));
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      debugLog("app-server", "failed to read session subagent metadata", {
        path: sessionPath,
        error: normalizeError(error).message,
      });
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async loadSessionSyntheticCollabCalls(
    sessionPath: string,
  ): Promise<SessionSyntheticCollabCallRecord[]> {
    try {
      const contents = await readFile(sessionPath, "utf8");
      return parseSessionSyntheticCollabCalls(contents);
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      debugLog("app-server", "failed to read session synthetic collab calls", {
        path: sessionPath,
        error: normalizeError(error).message,
      });
      return [];
    }
  }

  private sendJsonRpcMessage(message: JsonRecord): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async handleLocalJsonRpcRequest(
    method: string,
    params: unknown,
  ): Promise<{ handled: true; result: unknown } | { handled: false }> {
    switch (method) {
      case "experimentalFeature/list":
        return {
          handled: true,
          result: this.listExperimentalFeatures(params),
        };
      case "experimentalFeature/enablement/set":
        return {
          handled: true,
          result: this.setExperimentalFeatureEnablement(params),
        };
      default:
        return {
          handled: false,
        };
    }
  }

  private listExperimentalFeatures(params: unknown): {
    data: Array<{ name: string; enabled: boolean }>;
    nextCursor: string | null;
  } {
    const requestedCursor =
      isJsonRecord(params) && typeof params.cursor === "string" ? params.cursor : null;
    const startIndex = parseExperimentalFeatureCursor(requestedCursor);
    const requestedLimit =
      isJsonRecord(params) ? normalizePositiveInteger(params.limit) : null;
    const featureEntries = Object.entries(this.getExperimentalFeatureEnablement()).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const limit = requestedLimit ?? (featureEntries.length || 100);
    const data = featureEntries
      .slice(startIndex, startIndex + limit)
      .map(([name, enabled]) => ({ name, enabled }));
    const nextCursor =
      startIndex + data.length < featureEntries.length ? String(startIndex + data.length) : null;

    debugLog("app-server", "served experimental feature list", {
      requestedCursor,
      nextCursor,
      limit,
      totalFeatureCount: featureEntries.length,
      features: data,
    });

    return {
      data,
      nextCursor,
    };
  }

  private setExperimentalFeatureEnablement(params: unknown): {
    name: string;
    featureName: string;
    enabled: boolean;
  } {
    const featureName =
      isJsonRecord(params) && typeof params.featureName === "string"
        ? params.featureName.trim()
        : "";
    if (featureName.length === 0) {
      throw new Error("Missing experimental feature name.");
    }

    const enabled =
      isJsonRecord(params) && typeof params.enabled === "boolean" ? params.enabled : false;
    const features = this.getExperimentalFeatureEnablement();
    const wasKnown =
      Object.prototype.hasOwnProperty.call(DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT, featureName) ||
      featureName in features;
    features[featureName] = enabled;
    this.globalState.set(EXPERIMENTAL_FEATURES_STATE_KEY, features);
    this.queueGlobalStateRegistryWrite();

    if (!wasKnown) {
      warnOnceLog(
        "app-server",
        `experimental-feature-discovered:${featureName}`,
        "discovered new experimental feature name",
        {
          featureName,
          enabled,
        },
      );
    }

    debugLog("app-server", "updated experimental feature enablement", {
      featureName,
      enabled,
    });

    return {
      name: featureName,
      featureName,
      enabled,
    };
  }

  private getExperimentalFeatureEnablement(): Record<string, boolean> {
    return {
      ...DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT,
      ...normalizeExperimentalFeatureEnablementMap(
        this.globalState.get(EXPERIMENTAL_FEATURES_STATE_KEY),
      ),
    };
  }

  private async sendLocalRequest(method: string, params?: unknown): Promise<unknown> {
    const localResult = await this.handleLocalJsonRpcRequest(method, params);
    if (localResult.handled) {
      return localResult.result;
    }

    const id = `pocodex-local-${++this.nextRequestId}`;
    return new Promise<unknown>((resolve, reject) => {
      this.localRequests.set(id, { method, params, resolve, reject });
      this.sendJsonRpcMessage({
        id,
        method,
        params,
      });
    });
  }

  private rejectPendingRequests(error: Error): void {
    this.localRequests.forEach(({ reject }) => reject(error));
    this.localRequests.clear();
    this.pendingRemoteRequestMethods.clear();
    this.pendingRemoteRequestParams.clear();
  }

  private listExistingPaths(body: unknown): string[] {
    if (!isJsonRecord(body) || !Array.isArray(body.paths)) {
      return [];
    }

    return body.paths.filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0 && existsSync(value),
    );
  }
}

function buildIpcErrorResponse(requestId: string, error: string): JsonRecord {
  return {
    requestId,
    type: "response",
    resultType: "error",
    error,
  };
}

function buildIpcSuccessResponse(requestId: string, result: unknown): JsonRecord {
  return {
    requestId,
    type: "response",
    resultType: "success",
    result,
  };
}

function buildJsonRpcError(code: number, message: string): JsonRecord {
  return {
    code,
    message,
  };
}

async function resolveGitOrigins(
  body: unknown,
  fallbackDirs: string[],
): Promise<GitOriginsResponse> {
  const requestedDirs = readGitOriginDirectories(body);
  const dirs = requestedDirs.length > 0 ? requestedDirs : uniqueStrings(fallbackDirs);
  if (dirs.length === 0) {
    return {
      origins: [],
      homeDir: homedir(),
    };
  }

  const repositoriesByRoot = new Map<string, GitRepositoryInfo>();
  const originsByDir = new Map<string, GitOriginRecord>();

  for (const dir of dirs) {
    const origin = await resolveGitOrigin(dir, repositoriesByRoot);
    if (origin) {
      originsByDir.set(origin.dir, origin);
    }
  }

  for (const repository of repositoriesByRoot.values()) {
    const worktreeRoots = await listGitWorktreeRoots(repository.root);
    for (const worktreeRoot of worktreeRoots) {
      if (originsByDir.has(worktreeRoot)) {
        continue;
      }

      originsByDir.set(worktreeRoot, {
        dir: worktreeRoot,
        root: worktreeRoot,
        originUrl: repository.originUrl,
      });
    }
  }

  return {
    origins: Array.from(originsByDir.values()),
    homeDir: homedir(),
  };
}

async function resolveGitOrigin(
  dir: string,
  repositoriesByRoot: Map<string, GitRepositoryInfo>,
): Promise<GitOriginRecord | null> {
  const repository = await resolveGitRepository(dir, repositoriesByRoot);
  if (!repository) {
    return null;
  }

  return {
    dir,
    root: repository.root,
    originUrl: repository.originUrl,
  };
}

async function resolveGitRepository(
  dir: string,
  repositoriesByRoot: Map<string, GitRepositoryInfo>,
): Promise<GitRepositoryInfo | null> {
  let root: string;
  try {
    root = await runGitCommand(resolve(dir), ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }

  if (root.length === 0) {
    return null;
  }

  const existingRepository = repositoriesByRoot.get(root);
  if (existingRepository) {
    return existingRepository;
  }

  let originUrl: string | null;
  try {
    const configuredOriginUrl = await runGitCommand(root, ["config", "--get", "remote.origin.url"]);
    originUrl = configuredOriginUrl.length > 0 ? configuredOriginUrl : null;
  } catch {
    originUrl = null;
  }

  const repository: GitRepositoryInfo = {
    root,
    originUrl,
  };
  repositoriesByRoot.set(root, repository);
  return repository;
}

async function listGitWorktreeRoots(root: string): Promise<string[]> {
  try {
    const output = await runGitCommand(root, ["worktree", "list", "--porcelain"]);
    const worktreeRoots = output.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("worktree ")) {
        return [];
      }

      const worktreeRoot = line.slice("worktree ".length).trim();
      return worktreeRoot.length > 0 ? [worktreeRoot] : [];
    });
    return uniqueStrings([root, ...worktreeRoots]);
  } catch {
    return [root];
  }
}

function readGitOriginDirectories(body: unknown): string[] {
  const params = isJsonRecord(body) && isJsonRecord(body.params) ? body.params : body;
  if (!isJsonRecord(params) || !Array.isArray(params.dirs)) {
    return [];
  }

  return uniqueStrings(params.dirs);
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
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

function extractJsonRpcErrorMessage(error: unknown): string {
  if (isJsonRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function parseResponseBody(bodyText: string): unknown {
  if (!bodyText) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
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

function normalizeRequestBody(body: unknown): BodyInit | undefined {
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

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseSessionSubagentMetadata(payload: unknown): SessionSubagentMetadata | null {
  if (!isJsonRecord(payload) || payload.type !== "session_meta" || !isJsonRecord(payload.payload)) {
    return null;
  }

  const metadata = payload.payload;
  const source = isJsonRecord(metadata.source) ? metadata.source : null;
  const subagent = source && isJsonRecord(source.subagent) ? source.subagent : null;
  const threadSpawn = subagent && isJsonRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  const parentThreadId = normalizeNonEmptyString(threadSpawn?.parent_thread_id);
  if (!parentThreadId) {
    return null;
  }

  const agentNickname =
    normalizeNonEmptyString(metadata.agent_nickname) ??
    normalizeNonEmptyString(threadSpawn?.agent_nickname);
  const agentRole =
    normalizeNonEmptyString(metadata.agent_role) ??
    normalizeNonEmptyString(threadSpawn?.agent_role);

  return {
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: parentThreadId,
          depth: normalizeInteger(threadSpawn?.depth),
          agent_nickname: agentNickname,
          agent_role: agentRole,
        },
      },
    },
    agentNickname,
    agentRole,
  };
}

function parseSessionThreadIndexRecord(payload: unknown): SessionThreadIndexRecord | null {
  if (!isJsonRecord(payload) || payload.type !== "session_meta" || !isJsonRecord(payload.payload)) {
    return null;
  }

  const metadata = payload.payload;
  const threadId = normalizeNonEmptyString(metadata.id);
  if (!threadId) {
    return null;
  }

  const source = isJsonRecord(metadata.source) ? metadata.source : null;
  const subagent = source && isJsonRecord(source.subagent) ? source.subagent : null;
  const threadSpawn = subagent && isJsonRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  const parentThreadId = normalizeNonEmptyString(threadSpawn?.parent_thread_id);
  const timestampText = normalizeNonEmptyString(metadata.timestamp);
  const timestampMs = timestampText ? Date.parse(timestampText) : Number.NaN;

  return {
    threadId,
    parentThreadId,
    timestamp: Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : null,
  };
}

function parseSessionSyntheticCollabCalls(contents: string): SessionSyntheticCollabCallRecord[] {
  const pendingCalls = new Map<
    string,
    {
      timestampMs: number | null;
      agentId: string | null;
      agentNickname: string | null;
      agentRole: string | null;
      prompt: string | null;
      model: string | null;
      reasoningEffort: string | null;
      tool: string;
      status: "inProgress" | "completed";
      agentStateStatus: "running" | "completed";
      agentStateMessage: string | null;
    }
  >();
  const agentIdToCallIds = new Map<string, string[]>();

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isJsonRecord(entry) || !isJsonRecord(entry.payload)) {
      continue;
    }

    const payload = entry.payload;
    const timestampMs = normalizeTimestampMs(entry.timestamp);

    if (entry.type === "response_item" && payload.type === "function_call") {
      const callId = normalizeNonEmptyString(payload.call_id);
      const functionName = normalizeNonEmptyString(payload.name);
      const argumentsPayload = safeParseJsonString(payload.arguments);
      if (!callId || !functionName || !isJsonRecord(argumentsPayload)) {
        continue;
      }

      if (functionName === "spawn_agent") {
        pendingCalls.set(callId, {
          timestampMs,
          agentId: null,
          agentNickname: null,
          agentRole: normalizeNonEmptyString(argumentsPayload.agent_type),
          prompt: normalizeNonEmptyString(argumentsPayload.message),
          model: normalizeNonEmptyString(argumentsPayload.model),
          reasoningEffort: normalizeNonEmptyString(argumentsPayload.reasoning_effort),
          tool: mapSyntheticCollabToolName(functionName),
          status: "inProgress",
          agentStateStatus: "running",
          agentStateMessage: null,
        });
        continue;
      }

      if (functionName === "close_agent") {
        const targetAgentId = normalizeNonEmptyString(argumentsPayload.target);
        if (!targetAgentId) {
          continue;
        }
        for (const callIdForAgent of agentIdToCallIds.get(targetAgentId) ?? []) {
          const pending = pendingCalls.get(callIdForAgent);
          if (!pending) {
            continue;
          }
          pending.status = "completed";
          if (pending.agentStateStatus !== "completed") {
            pending.agentStateStatus = "completed";
          }
        }
      }

      continue;
    }

    if (entry.type === "response_item" && payload.type === "function_call_output") {
      const callId = normalizeNonEmptyString(payload.call_id);
      const pending = callId ? pendingCalls.get(callId) : null;
      if (!callId) {
        continue;
      }

      const outputPayload = safeParseJsonString(payload.output);
      if (pending) {
        const agentId = isJsonRecord(outputPayload)
          ? normalizeNonEmptyString(outputPayload.agent_id)
          : null;
        if (agentId) {
          pending.agentId = agentId;
          pending.agentNickname =
            normalizeNonEmptyString((outputPayload as JsonRecord).nickname) ?? pending.agentNickname;
          const existing = agentIdToCallIds.get(agentId) ?? [];
          if (!existing.includes(callId)) {
            existing.push(callId);
            agentIdToCallIds.set(agentId, existing);
          }
          continue;
        }
      }

      if (isJsonRecord(outputPayload) && isJsonRecord(outputPayload.status)) {
        for (const [agentId, statusValue] of Object.entries(outputPayload.status)) {
          if (typeof agentId !== "string" || !isJsonRecord(statusValue)) {
            continue;
          }
          for (const callIdForAgent of agentIdToCallIds.get(agentId) ?? []) {
            const collabCall = pendingCalls.get(callIdForAgent);
            if (!collabCall) {
              continue;
            }
            const [agentStateStatus, agentStateMessage] = normalizeAgentState(statusValue);
            collabCall.status = agentStateStatus === "completed" ? "completed" : collabCall.status;
            collabCall.agentStateStatus = agentStateStatus;
            collabCall.agentStateMessage = agentStateMessage;
            if (collabCall.timestampMs === null) {
              collabCall.timestampMs = timestampMs;
            }
          }
        }
      }

      continue;
    }

    if (entry.type !== "response_item" || payload.type !== "message" || payload.role !== "user") {
      continue;
    }

    const notification = extractSubagentNotificationPayload(payload.content);
    const agentId = normalizeNonEmptyString(notification?.agent_path);
    const statusPayload = notification && isJsonRecord(notification.status) ? notification.status : null;
    if (!agentId || !statusPayload) {
      continue;
    }

    for (const callId of agentIdToCallIds.get(agentId) ?? []) {
      const collabCall = pendingCalls.get(callId);
      if (!collabCall) {
        continue;
      }
      const [agentStateStatus, agentStateMessage] = normalizeAgentState(statusPayload);
      collabCall.status = agentStateStatus === "completed" ? "completed" : collabCall.status;
      collabCall.agentStateStatus = agentStateStatus;
      collabCall.agentStateMessage = agentStateMessage;
      if (collabCall.timestampMs === null) {
        collabCall.timestampMs = timestampMs;
      }
    }
  }

  return [...pendingCalls.values()]
    .filter((record): record is SessionSyntheticCollabCallRecord => record.agentId !== null)
    .map((record) => ({
      timestampMs: record.timestampMs,
      agentId: record.agentId,
      agentNickname: record.agentNickname,
      agentRole: record.agentRole,
      prompt: record.prompt,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      tool: record.tool,
      status: record.status,
      agentStateStatus: record.agentStateStatus,
      agentStateMessage: record.agentStateMessage,
    }));
}

function injectSyntheticCollabToolCalls(
  turns: unknown[],
  senderThreadId: string,
  collabCalls: readonly SessionSyntheticCollabCallRecord[],
): unknown[] {
  if (turns.length === 0 || collabCalls.length === 0) {
    return turns;
  }

  const nextTurns = [...turns];
  let changed = false;

  for (const collabCall of collabCalls) {
    const turnIndex = findBestSyntheticTurnIndex(turns, collabCall.timestampMs);
    if (turnIndex < 0) {
      continue;
    }

    const turn = nextTurns[turnIndex];
    if (!isJsonRecord(turn)) {
      continue;
    }

    const items = Array.isArray(turn.items) ? turn.items : [];
    if (hasSyntheticCollabToolCall(items, collabCall.agentId)) {
      continue;
    }

    nextTurns[turnIndex] = {
      ...turn,
      items: [...items, buildSyntheticCollabToolCall(senderThreadId, collabCall)],
    };
    changed = true;
  }

  return changed ? nextTurns : turns;
}

function findBestSyntheticTurnIndex(turns: readonly unknown[], timestampMs: number | null): number {
  if (turns.length === 0) {
    return -1;
  }

  if (timestampMs === null) {
    return turns.length - 1;
  }

  let bestIndex = -1;
  let bestTimestamp = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!isJsonRecord(turn)) {
      continue;
    }

    const turnTimestamp =
      normalizeTimestampMs(turn.turnStartedAtMs) ??
      normalizeTimestampMs(turn.startedAt) ??
      normalizeTimestampMs(turn.createdAt);
    if (turnTimestamp === null || turnTimestamp > timestampMs || turnTimestamp < bestTimestamp) {
      continue;
    }

    bestIndex = index;
    bestTimestamp = turnTimestamp;
  }

  return bestIndex >= 0 ? bestIndex : turns.length - 1;
}

function buildSyntheticCollabToolCall(
  senderThreadId: string,
  collabCall: SessionSyntheticCollabCallRecord,
): JsonRecord {
  return {
    id: `pocodex-collab-agent-${collabCall.agentId}`,
    type: "collabAgentToolCall",
    tool: collabCall.tool,
    status: collabCall.status,
    senderThreadId,
    receiverThreadIds: [collabCall.agentId],
    receiverThreads: [
      {
        threadId: collabCall.agentId,
        thread: null,
      },
    ],
    prompt: collabCall.prompt ?? "",
    model: collabCall.model,
    reasoningEffort: collabCall.reasoningEffort,
    agentsStates: {
      [collabCall.agentId]: {
        status: collabCall.agentStateStatus,
        message: collabCall.agentStateMessage,
        nickname: collabCall.agentNickname,
        role: collabCall.agentRole,
      },
    },
  };
}

function hasSyntheticCollabToolCall(items: readonly unknown[], agentId: string): boolean {
  return items.some(
    (item) =>
      isJsonRecord(item) &&
      item.type === "collabAgentToolCall" &&
      Array.isArray(item.receiverThreadIds) &&
      item.receiverThreadIds.includes(agentId),
  );
}

function extractSubagentNotificationPayload(content: unknown): JsonRecord | null {
  if (!Array.isArray(content)) {
    return null;
  }

  for (const item of content) {
    if (!isJsonRecord(item)) {
      continue;
    }

    const text =
      normalizeNonEmptyString(item.text) ??
      normalizeNonEmptyString(item.output_text) ??
      normalizeNonEmptyString(item.input_text);
    if (!text) {
      continue;
    }

    const match = text.match(/<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/i);
    if (!match) {
      continue;
    }

    const payload = safeParseJsonString(match[1]);
    if (isJsonRecord(payload)) {
      return payload;
    }
  }

  return null;
}

function normalizeAgentState(statusPayload: JsonRecord): ["running" | "completed", string | null] {
  const completedMessage = normalizeNonEmptyString(statusPayload.completed);
  if (completedMessage) {
    return ["completed", completedMessage];
  }

  const failedMessage = normalizeNonEmptyString(statusPayload.failed);
  if (failedMessage) {
    return ["completed", failedMessage];
  }

  const runningMessage =
    normalizeNonEmptyString(statusPayload.running) ?? normalizeNonEmptyString(statusPayload.in_progress);
  if (runningMessage) {
    return ["running", runningMessage];
  }

  return ["completed", null];
}

function mapSyntheticCollabToolName(tool: string): string {
  switch (tool) {
    case "spawn_agent":
      return "spawnAgent";
    case "send_input":
      return "sendInput";
    case "close_agent":
      return "closeAgent";
    case "wait_agent":
      return "wait";
    default:
      return tool;
  }
}

function safeParseJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeThreadListRequestParams(requestParams: unknown): ThreadListRequestParams {
  const params = isJsonRecord(requestParams) ? requestParams : null;
  const modelProviders = Array.isArray(params?.modelProviders)
    ? new Set(
        params.modelProviders.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ),
      )
    : null;

  return {
    archived: params?.archived === true,
    limit: normalizePositiveInteger(params?.limit),
    modelProviderSet: modelProviders && modelProviders.size > 0 ? modelProviders : null,
    searchTerm: normalizeNonEmptyString(params?.searchTerm)?.toLowerCase() ?? null,
    sortKey: params?.sortKey === "created_at" ? "created_at" : "updated_at",
  };
}

function matchesThreadListFilters(thread: JsonRecord, params: ThreadListRequestParams): boolean {
  if (params.modelProviderSet) {
    const modelProvider = normalizeNonEmptyString(thread.modelProvider);
    if (!modelProvider || !params.modelProviderSet.has(modelProvider)) {
      return false;
    }
  }

  if (!params.searchTerm) {
    return true;
  }

  const searchHaystack = [
    normalizeNonEmptyString(thread.id),
    normalizeNonEmptyString(thread.name),
    normalizeNonEmptyString(thread.preview),
    normalizeNonEmptyString(thread.cwd),
    normalizeNonEmptyString(thread.agentNickname),
    normalizeNonEmptyString(thread.agentRole),
  ]
    .filter((value): value is string => value !== null)
    .join("\n")
    .toLowerCase();

  return searchHaystack.includes(params.searchTerm);
}

function compareThreadListRecords(
  left: unknown,
  right: unknown,
  sortKey: ThreadListRequestParams["sortKey"],
): number {
  const leftRecord = isJsonRecord(left) ? left : null;
  const rightRecord = isJsonRecord(right) ? right : null;
  const leftTimestamp = readThreadListTimestamp(leftRecord, sortKey);
  const rightTimestamp = readThreadListTimestamp(rightRecord, sortKey);
  if (leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }

  const leftId = normalizeNonEmptyString(leftRecord?.id) ?? "";
  const rightId = normalizeNonEmptyString(rightRecord?.id) ?? "";
  return rightId.localeCompare(leftId);
}

function readThreadListTimestamp(
  record: JsonRecord | null,
  sortKey: ThreadListRequestParams["sortKey"],
): number {
  if (!record) {
    return 0;
  }

  const candidate =
    sortKey === "created_at"
      ? normalizeNumber(record.createdAt)
      : normalizeNumber(record.updatedAt) ?? normalizeNumber(record.createdAt);
  return candidate ?? 0;
}

function uniqueStrings(values: unknown[]): string[] {
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

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeInteger(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = normalizeInteger(value);
  return normalized !== null && normalized > 0 ? normalized : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeExperimentalFeatureEnablementMap(value: unknown): Record<string, boolean> {
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

function parseExperimentalFeatureCursor(cursor: string | null): number {
  if (!cursor) {
    return 0;
  }

  const parsed = Number.parseInt(cursor, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function hasNonEmptyString(value: unknown): value is string {
  return normalizeNonEmptyString(value) !== null;
}

function hasSubagentThreadSource(source: unknown): boolean {
  return (
    isJsonRecord(source) &&
    isJsonRecord(source.subAgent) &&
    isJsonRecord(source.subAgent.thread_spawn) &&
    typeof source.subAgent.thread_spawn.parent_thread_id === "string"
  );
}

function extractThreadSessionPath(thread: JsonRecord): string | null {
  const pathCandidates = [thread.path, thread.rolloutPath];
  for (const candidate of pathCandidates) {
    const normalized = normalizeNonEmptyString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function arraysReferenceEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
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

function extractPathFromCodexFetchBody(body: unknown): string | null {
  if (!isJsonRecord(body)) {
    return null;
  }

  const params = isJsonRecord(body.params) ? body.params : body;
  return typeof params.path === "string" && params.path.trim().length > 0 ? params.path : null;
}

function extractFetchParams(body: unknown): unknown {
  return isJsonRecord(body) && isJsonRecord(body.params) ? body.params : body;
}

function extractStringParam(body: unknown, key: string): string | null {
  const params = extractFetchParams(body);
  if (!isJsonRecord(params) || typeof params[key] !== "string") {
    return null;
  }

  const value = params[key].trim();
  return value.length > 0 ? value : null;
}

function extractResolvedPathParam(body: unknown, key: string): string | null {
  const value = extractStringParam(body, key);
  return value ? resolve(value) : null;
}

function buildWorktreeConfigStorageKey(root: string, scope: string, key: string): string {
  return `${WORKTREE_CONFIG_VALUE_PREFIX}${scope}:${root}:${key}`;
}

function buildLocalEnvironmentDirectoryPath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), ".codex", "environments");
}

function buildDefaultLocalEnvironmentConfigPath(workspaceRoot: string): string {
  return join(
    buildLocalEnvironmentDirectoryPath(workspaceRoot),
    DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME,
  );
}

function parseLocalEnvironmentDocument(raw: string): LocalEnvironmentDocument {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const environment: LocalEnvironmentDocument = {
    version: 1,
    name: "local",
    setup: {
      script: "",
    },
    actions: [],
  };

  let currentSection:
    | "root"
    | "setup"
    | "setup.darwin"
    | "setup.linux"
    | "setup.win32"
    | "actions" = "root";
  let currentAction: LocalEnvironmentAction | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line === "[setup]") {
      if (currentAction) {
        maybePushLocalEnvironmentAction(environment.actions, currentAction);
        currentAction = null;
      }
      currentSection = "setup";
      continue;
    }

    if (line === "[setup.darwin]" || line === "[setup.linux]" || line === "[setup.win32]") {
      if (currentAction) {
        maybePushLocalEnvironmentAction(environment.actions, currentAction);
        currentAction = null;
      }
      currentSection = line.slice(1, -1) as "setup.darwin" | "setup.linux" | "setup.win32";
      continue;
    }

    if (line === "[[actions]]") {
      if (currentAction) {
        maybePushLocalEnvironmentAction(environment.actions, currentAction);
      }
      currentAction = {
        name: "",
        command: "",
      };
      currentSection = "actions";
      continue;
    }

    const keyMatch = rawLine.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!keyMatch) {
      continue;
    }

    const [, key, rawValue] = keyMatch;
    let value: unknown;
    if (rawValue.startsWith("'''") || rawValue.startsWith('"""')) {
      const parsed = readTomlMultilineString(lines, index, rawValue);
      value = parsed.value;
      index = parsed.nextIndex;
    } else {
      value = parseTomlScalar(rawValue);
    }

    switch (currentSection) {
      case "root":
        if (key === "version" && typeof value === "number") {
          environment.version = value;
        } else if (key === "name" && typeof value === "string") {
          environment.name = value;
        }
        break;
      case "setup":
        if (key === "script" && typeof value === "string") {
          environment.setup.script = value;
        }
        break;
      case "setup.darwin":
        if (key === "script" && typeof value === "string") {
          environment.setup.darwin = { script: value };
        }
        break;
      case "setup.linux":
        if (key === "script" && typeof value === "string") {
          environment.setup.linux = { script: value };
        }
        break;
      case "setup.win32":
        if (key === "script" && typeof value === "string") {
          environment.setup.win32 = { script: value };
        }
        break;
      case "actions":
        if (!currentAction) {
          currentAction = {
            name: "",
            command: "",
          };
        }
        if (key === "name" && typeof value === "string") {
          currentAction.name = value;
        } else if (key === "icon" && typeof value === "string") {
          currentAction.icon = value;
        } else if (key === "command" && typeof value === "string") {
          currentAction.command = value;
        } else if (
          key === "platform" &&
          (value === "darwin" || value === "linux" || value === "win32")
        ) {
          currentAction.platform = value;
        }
        break;
    }
  }

  if (currentAction) {
    maybePushLocalEnvironmentAction(environment.actions, currentAction);
  }

  return environment;
}

function maybePushLocalEnvironmentAction(
  actions: LocalEnvironmentAction[],
  action: LocalEnvironmentAction,
): void {
  const name = action.name.trim();
  const command = action.command.trim();
  if (!name || !command) {
    return;
  }

  actions.push({
    name,
    command,
    ...(action.icon ? { icon: action.icon } : {}),
    ...(action.platform ? { platform: action.platform } : {}),
  });
}

function parseTomlScalar(rawValue: string): unknown {
  const value = rawValue.trim();
  if (!value) {
    return "";
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readTomlMultilineString(
  lines: string[],
  startIndex: number,
  rawValue: string,
): { value: string; nextIndex: number } {
  const delimiter = rawValue.startsWith('"""') ? '"""' : "'''";
  const initial = rawValue.slice(delimiter.length);
  if (initial.endsWith(delimiter)) {
    return {
      value: decodeTomlMultilineString(initial.slice(0, -delimiter.length), delimiter),
      nextIndex: startIndex,
    };
  }

  const collected: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === delimiter) {
      return {
        value: decodeTomlMultilineString(collected.join("\n"), delimiter),
        nextIndex: index,
      };
    }
    if (line.endsWith(delimiter)) {
      collected.push(line.slice(0, -delimiter.length));
      return {
        value: decodeTomlMultilineString(collected.join("\n"), delimiter),
        nextIndex: index,
      };
    }
    collected.push(line);
  }

  throw new Error("Unterminated multiline TOML string.");
}

function decodeTomlMultilineString(value: string, delimiter: string): string {
  if (delimiter === "'''") {
    return value;
  }

  return value.replace(/\\"""/g, '"""').replace(/\\\\/g, "\\");
}

function stripFileExtension(fileName: string): string {
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return fileName;
  }
  return fileName.slice(0, extensionIndex);
}

function buildSearchableWorkspacePath(options: {
  absolutePath: string;
  root: string;
  rootLabel: string;
  includeRootName: boolean;
}): string {
  const relativePath = relative(options.root, options.absolutePath);
  if (!options.includeRootName) {
    return relativePath;
  }

  return relativePath.length > 0 ? `${options.rootLabel}/${relativePath}` : options.rootLabel;
}

function isPathInsideRoot(root: string, targetPath: string): boolean {
  const relativePath = relative(root, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function rankWorkspaceFiles(
  files: SearchableWorkspaceFile[],
  query: string,
  limit: number,
): string[] {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return files
      .slice()
      .sort((left, right) => left.searchablePath.localeCompare(right.searchablePath))
      .slice(0, limit)
      .map((file) => file.absolutePath);
  }

  return files
    .map((file) => ({
      file,
      score: scoreWorkspacePathMatch(file.searchablePath, trimmedQuery),
    }))
    .filter(
      (entry): entry is { file: SearchableWorkspaceFile; score: number } => entry.score !== null,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.file.searchablePath.length !== right.file.searchablePath.length) {
        return left.file.searchablePath.length - right.file.searchablePath.length;
      }
      return left.file.searchablePath.localeCompare(right.file.searchablePath);
    })
    .slice(0, limit)
    .map((entry) => entry.file.absolutePath);
}

function scoreWorkspacePathMatch(path: string, query: string): number | null {
  const normalizedPath = path.toLowerCase();
  const normalizedBaseName = basename(path).toLowerCase();

  if (normalizedBaseName === query) {
    return 0;
  }
  if (normalizedBaseName.startsWith(query)) {
    return 10 + Math.max(0, normalizedBaseName.length - query.length);
  }
  if (normalizedBaseName.includes(query)) {
    return 30 + normalizedBaseName.indexOf(query);
  }
  if (normalizedPath.includes(query)) {
    return 100 + normalizedPath.indexOf(query);
  }

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let gaps = 0;
  let previousMatchIndex = -1;

  for (
    let pathIndex = 0;
    pathIndex < normalizedPath.length && queryIndex < query.length;
    pathIndex += 1
  ) {
    if (normalizedPath[pathIndex] !== query[queryIndex]) {
      continue;
    }
    if (firstMatchIndex === -1) {
      firstMatchIndex = pathIndex;
    }
    if (previousMatchIndex >= 0) {
      gaps += pathIndex - previousMatchIndex - 1;
    }
    previousMatchIndex = pathIndex;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) {
    return null;
  }

  return 500 + gaps + (firstMatchIndex === -1 ? 0 : firstMatchIndex);
}

function looksLikeBinaryFile(contents: Buffer): boolean {
  const sampleSize = Math.min(contents.length, 8_192);
  let suspiciousByteCount = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    const byte = contents[index];
    if (byte === 0) {
      return true;
    }
    const isControlCharacter = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    if (isControlCharacter) {
      suspiciousByteCount += 1;
    }
  }

  return sampleSize > 0 && suspiciousByteCount / sampleSize > 0.1;
}

function isWorkspacePreviewImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

async function execFileText(file: string, args: string[], cwd: string): Promise<string> {
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

async function pickDirectoryOnHost(preferredPath: string): Promise<string | null> {
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

async function pickDirectoryOnMac(startPath: string): Promise<string | null> {
  const script = [
    "try",
    `set chosenFolder to choose folder with prompt "Choose a workspace folder for Pocodex." default location POSIX file "${escapeAppleScriptString(startPath)}"`,
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
    "--title=Choose a workspace folder for Pocodex",
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
      ["--getexistingdirectory", startPath, "--title", "Choose a workspace folder for Pocodex"],
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

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
