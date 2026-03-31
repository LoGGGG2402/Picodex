import type { JsonRecord } from "../core/protocol.js";
import type {
  AppServerFetchCancel,
  AppServerFetchRequest,
  AppServerMcpNotificationEnvelope,
  AppServerMcpRequestEnvelope,
  AppServerMcpResponseEnvelope,
  PersistedAtomUpdateMessage,
} from "./shared.js";

export interface BrowserBridgeHandlersContext {
  emitConnectionState(): void;
  persistedAtoms: Map<string, unknown>;
  handlePersistedAtomUpdate(message: PersistedAtomUpdateMessage): void;
  handleSharedObjectSubscribe(message: JsonRecord): void;
  handleSharedObjectUnsubscribe(message: JsonRecord): void;
  handleSharedObjectSet(message: JsonRecord): void;
  handleThreadArchive(message: JsonRecord, method: "thread/archive" | "thread/unarchive"): Promise<void>;
  handleThreadRoleRequest(message: { type: string; requestId: string }): void;
  handleOnboardingPickWorkspaceOrCreateDefault(): Promise<void>;
  handleOnboardingSkipWorkspace(): Promise<void>;
  openDesktopImportDialog(mode: "first-run" | "manual"): void;
  handleWorkspaceRootsUpdated(message: JsonRecord): Promise<void>;
  handleSetActiveWorkspaceRoot(message: JsonRecord): Promise<void>;
  handleRenameWorkspaceRootOption(message: JsonRecord): Promise<void>;
  handleMcpRequest(message: AppServerMcpRequestEnvelope): Promise<void>;
  handleMcpNotification(message: AppServerMcpNotificationEnvelope): Promise<void>;
  handleMcpResponse(message: AppServerMcpResponseEnvelope): Promise<void>;
  terminalManager: {
    handleCreate(message: unknown): Promise<void>;
    handleAttach(message: unknown): Promise<void>;
    write(message: unknown): void;
    runAction(message: unknown): void;
    resize(message: unknown): void;
    close(message: unknown): void;
  };
  handleFetchRequest(message: AppServerFetchRequest): Promise<void>;
  handleFetchCancel(message: AppServerFetchCancel): void;
  emitBridgeMessage(message: JsonRecord): void;
  handleElectronAppStateSnapshotTrigger(message: JsonRecord & { type: string }): void;
}

export function createDroppedBrowserBridgeMessageTypes(): Set<string> {
  return new Set([
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
}

export function createLocalBrowserBridgeHandlers(
  bridge: BrowserBridgeHandlersContext,
): Map<string, (message: JsonRecord & { type: string }) => Promise<void> | void> {
  return new Map([
    ["ready", () => bridge.emitConnectionState()],
    [
      "persisted-atom-sync-request",
      () => {
        bridge.emitBridgeMessage({
          type: "persisted-atom-sync",
          state: Object.fromEntries(bridge.persistedAtoms),
        });
      },
    ],
    [
      "persisted-atom-update",
      (message: JsonRecord & { type: string }) =>
        bridge.handlePersistedAtomUpdate(message as unknown as PersistedAtomUpdateMessage),
    ],
    ["shared-object-subscribe", (message: JsonRecord & { type: string }) => bridge.handleSharedObjectSubscribe(message)],
    ["shared-object-unsubscribe", (message: JsonRecord & { type: string }) => bridge.handleSharedObjectUnsubscribe(message)],
    ["shared-object-set", (message: JsonRecord & { type: string }) => bridge.handleSharedObjectSet(message)],
    ["archive-thread", async (message: JsonRecord & { type: string }) => bridge.handleThreadArchive(message, "thread/archive")],
    ["unarchive-thread", async (message: JsonRecord & { type: string }) => bridge.handleThreadArchive(message, "thread/unarchive")],
    [
      "thread-role-request",
      (message: JsonRecord & { type: string }) =>
        bridge.handleThreadRoleRequest(message as { type: string; requestId: string }),
    ],
    ["electron-onboarding-pick-workspace-or-create-default", async () => bridge.handleOnboardingPickWorkspaceOrCreateDefault()],
    ["electron-onboarding-skip-workspace", async () => bridge.handleOnboardingSkipWorkspace()],
    ["electron-pick-workspace-root-option", () => bridge.openDesktopImportDialog("manual")],
    ["electron-add-new-workspace-root-option", () => bridge.openDesktopImportDialog("manual")],
    ["electron-update-workspace-root-options", async (message: JsonRecord & { type: string }) => bridge.handleWorkspaceRootsUpdated(message)],
    ["electron-set-active-workspace-root", async (message: JsonRecord & { type: string }) => bridge.handleSetActiveWorkspaceRoot(message)],
    ["electron-rename-workspace-root-option", async (message: JsonRecord & { type: string }) => bridge.handleRenameWorkspaceRootOption(message)],
    ["mcp-request", async (message: JsonRecord & { type: string }) => bridge.handleMcpRequest(message as unknown as AppServerMcpRequestEnvelope)],
    ["mcp-notification", async (message: JsonRecord & { type: string }) => bridge.handleMcpNotification(message as unknown as AppServerMcpNotificationEnvelope)],
    ["mcp-response", async (message: JsonRecord & { type: string }) => bridge.handleMcpResponse(message as unknown as AppServerMcpResponseEnvelope)],
    ["terminal-create", async (message: JsonRecord & { type: string }) => bridge.terminalManager.handleCreate(message)],
    ["terminal-attach", async (message: JsonRecord & { type: string }) => bridge.terminalManager.handleAttach(message)],
    ["terminal-write", (message: JsonRecord & { type: string }) => bridge.terminalManager.write(message)],
    ["terminal-run-action", (message: JsonRecord & { type: string }) => bridge.terminalManager.runAction(message)],
    ["terminal-resize", (message: JsonRecord & { type: string }) => bridge.terminalManager.resize(message)],
    ["terminal-close", (message: JsonRecord & { type: string }) => bridge.terminalManager.close(message)],
    ["fetch", async (message: JsonRecord & { type: string }) => bridge.handleFetchRequest(message as unknown as AppServerFetchRequest)],
    ["cancel-fetch", (message: JsonRecord & { type: string }) => bridge.handleFetchCancel(message as unknown as AppServerFetchCancel)],
    [
      "fetch-stream",
      (message: JsonRecord & { type: string }) => {
        bridge.emitBridgeMessage({
          type: "fetch-stream-error",
          requestId: typeof message.requestId === "string" ? message.requestId : "",
          error: "Streaming fetch is not supported in Pocodex yet.",
        });
        bridge.emitBridgeMessage({
          type: "fetch-stream-complete",
          requestId: typeof message.requestId === "string" ? message.requestId : "",
        });
      },
    ],
    ["electron-app-state-snapshot-trigger", (message: JsonRecord & { type: string }) => bridge.handleElectronAppStateSnapshotTrigger(message)],
  ]);
}
