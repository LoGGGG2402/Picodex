import { randomUUID } from "node:crypto";

import { saveGlobalStateRegistry } from "../state/global-state-registry.js";
import { debugLog } from "../core/debug.js";
import type { JsonRecord } from "../core/protocol.js";
import { normalizeError, normalizeNonEmptyString } from "./utils.js";

export interface RuntimeStateContext {
  hostId: string;
  globalState: Map<string, unknown>;
  pinnedThreadIds: Set<string>;
  globalStateRegistryPath: string;
  globalStateWritePromise: Promise<void>;
  syntheticCollabHydrationTimers: Set<NodeJS.Timeout>;
  isClosing: boolean;
  getActiveWorkspaceRoots(): string[];
  setGlobalStateWritePromise(promise: Promise<void>): void;
  emit(event: "bridge_message", message: unknown): boolean;
  emitBridgeMessage(message: JsonRecord): void;
}

export function writeGlobalState(bridge: RuntimeStateContext, body: unknown): Record<string, never> {
  if (typeof body !== "object" || body === null || typeof (body as JsonRecord).key !== "string") {
    return {};
  }

  const record = body as JsonRecord;
  bridge.globalState.set(record.key as string, record.value);
  if (record.key === "pinned-thread-ids" && Array.isArray(record.value)) {
    bridge.pinnedThreadIds.clear();
    for (const value of record.value) {
      if (typeof value === "string") {
        bridge.pinnedThreadIds.add(value);
      }
    }
    bridge.emitBridgeMessage({ type: "pinned-threads-updated" });
  }

  queueGlobalStateRegistryWrite(bridge);
  return {};
}

export function setThreadPinned(bridge: RuntimeStateContext, body: unknown): Record<string, never> {
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const record = body as JsonRecord;
  const threadId =
    typeof record.threadId === "string"
      ? record.threadId
      : typeof record.conversationId === "string"
        ? record.conversationId
        : null;
  if (!threadId) {
    return {};
  }
  if (record.pinned === false) {
    bridge.pinnedThreadIds.delete(threadId);
  } else {
    bridge.pinnedThreadIds.add(threadId);
  }
  bridge.globalState.set("pinned-thread-ids", Array.from(bridge.pinnedThreadIds));
  queueGlobalStateRegistryWrite(bridge);
  bridge.emitBridgeMessage({ type: "pinned-threads-updated" });
  return {};
}

export function setPinnedThreadsOrder(bridge: RuntimeStateContext, body: unknown): Record<string, never> {
  if (typeof body !== "object" || body === null || !Array.isArray((body as JsonRecord).threadIds)) {
    return {};
  }
  const ordered = ((body as JsonRecord).threadIds as unknown[]).filter(
    (value): value is string => typeof value === "string",
  );
  const remaining = Array.from(bridge.pinnedThreadIds).filter((threadId) => !ordered.includes(threadId));

  bridge.pinnedThreadIds.clear();
  for (const threadId of [...ordered, ...remaining]) {
    bridge.pinnedThreadIds.add(threadId);
  }

  bridge.globalState.set("pinned-thread-ids", Array.from(bridge.pinnedThreadIds));
  queueGlobalStateRegistryWrite(bridge);
  bridge.emitBridgeMessage({ type: "pinned-threads-updated" });
  return {};
}

export function queueGlobalStateRegistryWrite(bridge: RuntimeStateContext): void {
  const state = Object.fromEntries(bridge.globalState);
  bridge.setGlobalStateWritePromise(
    bridge.globalStateWritePromise
      .catch(() => undefined)
      .then(async () => {
        try {
          await saveGlobalStateRegistry(bridge.globalStateRegistryPath, state);
        } catch (error) {
          debugLog("app-server", "failed to persist global state", {
            error: normalizeError(error).message,
            path: bridge.globalStateRegistryPath,
          });
        }
      }),
  );
}

export function buildHostConfig(hostId: string): Record<string, string> {
  return { id: hostId, display_name: "Local", kind: "local" };
}

export function emitFetchSuccess(
  bridge: RuntimeStateContext,
  requestId: string,
  body: unknown,
  status = 200,
): void {
  bridge.emit("bridge_message", {
    type: "fetch-response",
    requestId,
    responseType: "success",
    status,
    headers: { "content-type": "application/json" },
    bodyJsonString: JSON.stringify(body),
  });
}

export function emitFetchError(
  bridge: RuntimeStateContext,
  requestId: string,
  status: number,
  error: string,
): void {
  bridge.emit("bridge_message", {
    type: "fetch-response",
    requestId,
    responseType: "error",
    status,
    error,
  });
}

export function scheduleSyntheticCollabHydrationNotifications(
  bridge: RuntimeStateContext,
  method: string | null,
  payload: unknown,
): void {
  if (method !== "thread/read" && method !== "thread/resume") {
    return;
  }

  const thread =
    typeof payload === "object" && payload !== null && typeof (payload as JsonRecord).thread === "object"
      ? ((payload as JsonRecord).thread as JsonRecord)
      : null;
  if (!thread || typeof thread.id !== "string" || !Array.isArray(thread.turns)) {
    return;
  }

  const notifications: Array<{ threadId: string; turnId: string; item: JsonRecord }> = [];
  for (const turn of thread.turns) {
    if (!turn || typeof turn !== "object") {
      continue;
    }
    const record = turn as JsonRecord;
    if (typeof record.id !== "string" || !Array.isArray(record.items)) {
      continue;
    }
    for (const item of record.items) {
      if (
        !item ||
        typeof item !== "object" ||
        (item as JsonRecord).type !== "collabAgentToolCall" ||
        typeof (item as JsonRecord).id !== "string" ||
        !Array.isArray((item as JsonRecord).receiverThreadIds) ||
        ((item as JsonRecord).receiverThreadIds as unknown[]).length === 0
      ) {
        continue;
      }
      notifications.push({ threadId: thread.id, turnId: record.id, item: item as JsonRecord });
    }
  }

  if (notifications.length === 0) {
    return;
  }

  const retryDelaysMs = [0, 50, 250, 1000];
  for (const delayMs of retryDelaysMs) {
    const timer = setTimeout(() => {
      bridge.syntheticCollabHydrationTimers.delete(timer);
      if (bridge.isClosing) {
        return;
      }
      for (const notification of notifications) {
        bridge.emitBridgeMessage({
          type: "mcp-notification",
          hostId: bridge.hostId,
          method: "item/completed",
          params: {
            threadId: notification.threadId,
            turnId: notification.turnId,
            item: notification.item,
          },
        });
      }
    }, delayMs);
    bridge.syntheticCollabHydrationTimers.add(timer);
  }

  debugLog("app-server", "scheduled synthetic collab hydration notifications", {
    method,
    threadId: thread.id,
    notificationCount: notifications.length,
    retryDelaysMs,
  });
}

export function handleElectronAppStateSnapshotTrigger(
  bridge: RuntimeStateContext,
  message: JsonRecord & { type: string },
): void {
  const reason = normalizeNonEmptyString(message.reason) ?? "pocodex-bridge";
  const requestId = `pocodex-app-state-snapshot-${randomUUID()}`;
  debugLog("app-server", "bridging app state snapshot trigger", { requestId, reason });
  bridge.emitBridgeMessage({
    type: "electron-app-state-snapshot-request",
    hostId: bridge.hostId,
    requestId,
    reason,
  });
}
