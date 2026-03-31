import type { CodexDesktopGitWorkerBridge } from "../desktop/codex-desktop-git-worker.js";
import type { JsonRecord } from "../core/protocol.js";

export interface AppServerBridgeOptions {
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

export interface JsonRpcRequest {
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: unknown;
}

export interface AppServerFetchRequest {
  type: "fetch";
  requestId: string;
  method?: string;
  url?: string;
  headers?: unknown;
  body?: unknown;
}

export interface AppServerFetchCancel {
  type: "cancel-fetch";
  requestId: string;
}

export interface AppServerMcpRequestEnvelope {
  type: "mcp-request";
  request?: JsonRpcRequest;
}

export interface AppServerMcpNotificationEnvelope {
  type: "mcp-notification";
  request?: JsonRpcRequest;
}

export interface AppServerMcpResponseEnvelope {
  type: "mcp-response";
  response?: JsonRpcResponse;
  message?: JsonRpcResponse;
}

export interface TopLevelRequestMessage {
  type: string;
  requestId: string;
}

export interface PersistedAtomUpdateMessage {
  type: "persisted-atom-update";
  key?: unknown;
  value?: unknown;
  deleted?: unknown;
}

export interface GitOriginRecord {
  dir: string;
  root: string;
  originUrl: string | null;
}

export interface GitRepositoryInfo {
  root: string;
  originUrl: string | null;
}

export interface GitOriginsResponse {
  origins: GitOriginRecord[];
  homeDir: string;
}

export interface FuzzyFileSearchSession {
  roots: string[];
  query: string;
  revision: number;
}

export interface SearchableWorkspaceFile {
  absolutePath: string;
  searchablePath: string;
}

export interface WorkspaceBrowserRoot {
  path: string;
  label: string;
  active: boolean;
}

export interface WorkspaceBrowserEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: "directory" | "file";
}

export interface HostBrowserEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface WorkspaceBrowserSearchResult {
  root: string;
  path: string;
  relativePath: string;
}

export interface PendingLocalRequest {
  method: string;
  params?: unknown;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

export interface SessionSubagentThreadSpawnRecord {
  parent_thread_id: string;
  depth: number | null;
  agent_path?: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
}

export interface SessionSubagentMetadata {
  source: {
    subAgent: {
      thread_spawn: SessionSubagentThreadSpawnRecord;
    };
  };
  agentNickname: string | null;
  agentRole: string | null;
}

export interface SessionThreadIndexRecord {
  threadId: string;
  parentThreadId: string | null;
  timestamp: number | null;
}

export interface SessionSyntheticCollabCallRecord {
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
  receiverThread: JsonRecord | null;
}

export interface ResolvedSessionSyntheticCollabCallRecord
  extends SessionSyntheticCollabCallRecord {
  agentId: string;
}

export interface ThreadListRequestParams {
  archived: boolean;
  limit: number | null;
  modelProviderSet: Set<string> | null;
  searchTerm: string | null;
  sortKey: "created_at" | "updated_at";
}

export interface OpenInTarget {
  id: string;
  label: string;
  icon: string | null;
  available: boolean;
  default?: boolean;
}

export interface LocalEnvironmentAction {
  name: string;
  icon?: string;
  command: string;
  platform?: "darwin" | "linux" | "win32";
}

export interface LocalEnvironmentDocument {
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

export interface AutoTopUpSettings {
  is_enabled: boolean;
  recharge_threshold: number | null;
  recharge_target: number | null;
}

export const MAX_FUZZY_FILE_RESULTS = 200;
export const MAX_FUZZY_FILE_CANDIDATES = 10_000;
export const MAX_PREVIEW_FILE_BYTES = 1_000_000;
export const MAX_PREVIEW_MEDIA_BYTES = 10_000_000;
export const CONFIGURATION_STORAGE_PREFIX = "configuration:";
export const WORKTREE_CONFIG_VALUE_PREFIX = "worktree-config-value:";
export const PREFERRED_OPEN_TARGET_KEY = "preferred-open-target";
export const AUTO_TOP_UP_SETTINGS_KEY = "usage-auto-top-up";
export const EXPERIMENTAL_FEATURES_STATE_KEY = "experimental-features";
export const DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT: Record<string, boolean> = {
  multi_agent: true,
  apps: false,
  plugins: false,
  tool_call_mcp_elicitation: false,
  tool_search: false,
  tool_suggest: false,
};
export const DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME = "environment.toml";
export const DEFAULT_OPEN_IN_TARGET: OpenInTarget = {
  id: "pocodex-browser",
  label: "Pocodex browser",
  icon: null,
  available: true,
  default: true,
};
export const MAX_THREAD_LIST_SUBAGENT_READS = 60;
export const IGNORED_FILE_SEARCH_DIRECTORIES = new Set([
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
