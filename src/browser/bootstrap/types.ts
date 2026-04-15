import type { SentryInitOptions } from "../../core/protocol.js";

export interface BootstrapScriptConfig {
  sentryOptions: SentryInitOptions;
  stylesheetHref: string;
  embeddedMonoFontFamily?: string;
  embeddedMonoFontUrl?: string;
  importIconSvg?: string;
}

export type ConnectionStatusOptions = {
  mode?: string;
};

export type DesktopImportMode = "first-run" | "manual";

export type DesktopImportProject = {
  root: string;
  label: string;
  activeInCodex: boolean;
  alreadyImported: boolean;
  available: boolean;
};

export type DesktopImportListResult = {
  found: boolean;
  path: string;
  promptSeen: boolean;
  shouldPrompt: boolean;
  projects: DesktopImportProject[];
};

export type HostResolvedFile = {
  label: string;
  path: string;
  fsPath: string;
};

export type HostDirectoryEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
};

export type WorkspaceFileRoot = {
  path: string;
  label: string;
  active: boolean;
};

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  relativePath: string;
  kind: "directory" | "file";
};

export type WorkspaceFileReadResult =
  | {
      root: string;
      path: string;
      relativePath: string;
      kind: "text";
      mimeType: string;
      size: number;
      contents: string;
    }
  | {
      root: string;
      path: string;
      relativePath: string;
      kind: "image" | "pdf";
      mimeType: string;
      size: number;
      contentsBase64: string;
    }
  | {
      root: string;
      path: string;
      relativePath: string;
      kind: "binary";
      mimeType: string;
      size: number;
    };

export type WorkspaceFileSearchResult = {
  root: string;
  path: string;
  relativePath: string;
};

export type WorkspaceFileHighlightResult = {
  html: string;
  language: string;
};

export type SessionValidationResult =
  | { ok: true }
  | { ok: false; reason: "unauthorized" | "unavailable" };

export type WorkerMessageListener = (message: unknown) => void;

export interface ElectronBridge {
  windowType: "electron";
  sendMessageFromView(message: unknown): Promise<void>;
  getPathForFile(file: File): string | null;
  sendWorkerMessageFromView(workerName: string, message: unknown): Promise<void>;
  subscribeToWorkerMessages(workerName: string, callback: WorkerMessageListener): () => void;
  showContextMenu(): Promise<void>;
  getFastModeRolloutMetrics(): Promise<Record<string, never>>;
  triggerSentryTestError(): Promise<void>;
  getSentryInitOptions(): SentryInitOptions;
  getAppSessionId(): string;
  getBuildFlavor(): string;
}

export interface FilesState {
  open: boolean;
  roots: WorkspaceFileRoot[];
  selectedRoot: string | null;
  selectedFilePath: string | null;
  previewPath: string | null;
  previewRelativePath: string;
  previewKind: "text" | "image" | "pdf" | "binary" | null;
  previewMimeType: string;
  previewSizeBytes: number;
  previewContents: string;
  previewObjectUrl: string | null;
  previewHighlightedHtml: string;
  previewHighlightedLanguage: string;
  previewHighlighting: boolean;
  previewHighlightRevision: number;
  previewLoading: boolean;
  isRefreshing: boolean;
  searchQuery: string;
  searchResults: WorkspaceFileSearchResult[];
  searchLoading: boolean;
  status: string;
  drawerWidthPx: number | null;
  explorerWidthPx: number | null;
  directoryEntries: Map<string, WorkspaceFileEntry[]>;
  expandedDirectories: Set<string>;
  loadingDirectories: Set<string>;
}
