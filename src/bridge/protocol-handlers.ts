import { savePersistedAtomRegistry } from "../state/persisted-atom-registry.js";
import { debugLog } from "../core/debug.js";
import type {
  AppServerMcpNotificationEnvelope,
  AppServerMcpRequestEnvelope,
  AppServerMcpResponseEnvelope,
  PersistedAtomUpdateMessage,
  TopLevelRequestMessage,
} from "./shared.js";
import type { JsonRecord } from "../core/protocol.js";
import { buildJsonRpcError, extractJsonRpcErrorMessage, isJsonRecord, normalizeError } from "./utils.js";

export interface ProtocolHandlersContext {
  hostId: string;
  connectionState: "connecting" | "connected" | "disconnected";
  isInitialized: boolean;
  localRequests: Map<
    string,
    {
      method: string;
      params?: unknown;
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >;
  pendingRemoteRequestMethods: Map<string, string>;
  pendingRemoteRequestParams: Map<string, unknown>;
  persistedAtoms: Map<string, unknown>;
  sharedObjects: Map<string, unknown>;
  sharedObjectSubscriptions: Set<string>;
  persistedAtomRegistryPath: string;
  getPersistedAtomWritePromise(): Promise<void>;
  setPersistedAtomWritePromise(promise: Promise<void>): void;
  emit(event: "bridge_message" | "error", ...args: unknown[]): boolean;
  emitBridgeMessage(message: JsonRecord): void;
  sendJsonRpcMessage(message: JsonRecord): void;
  enrichThreadPayloadForMethod(method: string | null, payload: unknown, requestParams?: unknown): Promise<unknown>;
  scheduleSyntheticCollabHydrationNotifications(method: string | null, result: unknown): void;
  handleLocalJsonRpcRequest(
    method: string,
    params: unknown,
  ): Promise<{ handled: true; result: unknown } | { handled: false }>;
  sanitizeMcpParams(method: string, params: unknown): unknown;
  sendLocalRequest(method: string, params?: unknown): Promise<unknown>;
}

export function emitConnectionState(bridge: ProtocolHandlersContext): void {
  bridge.emit("bridge_message", {
    type: "codex-app-server-connection-changed",
    hostId: bridge.hostId,
    state: bridge.connectionState,
    transport: "websocket",
  });

  if (bridge.isInitialized) {
    bridge.emit("bridge_message", {
      type: "ready",
      hostId: bridge.hostId,
    });
  }
}

export async function handleStdoutLine(
  bridge: ProtocolHandlersContext,
  line: string,
): Promise<void> {
  if (!line.trim()) {
    return;
  }

  debugLog("app-server", "stdout", line);

  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (error) {
    bridge.emit(
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
    await handleJsonRpcResponse(bridge, message);
    return;
  }

  if (typeof message.method !== "string") {
    return;
  }

  if ("id" in message && (typeof message.id === "string" || typeof message.id === "number")) {
    bridge.emit("bridge_message", {
      type: "mcp-request",
      hostId: bridge.hostId,
      request: {
        id: message.id,
        method: message.method,
        params: message.params,
      },
    });
    return;
  }

  const params = await bridge.enrichThreadPayloadForMethod(message.method, message.params);
  bridge.emit("bridge_message", {
    type: "mcp-notification",
    hostId: bridge.hostId,
    method: message.method,
    params,
  });
}

export async function handleJsonRpcResponse(
  bridge: ProtocolHandlersContext,
  message: JsonRecord,
): Promise<void> {
  const id =
    typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : null;
  if (id && bridge.localRequests.has(id)) {
    const pending = bridge.localRequests.get(id);
    bridge.localRequests.delete(id);
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
    pending.resolve(await bridge.enrichThreadPayloadForMethod(pending.method, message.result, pending.params));
    return;
  }

  const method = id ? bridge.pendingRemoteRequestMethods.get(id) ?? null : null;
  const params = id ? bridge.pendingRemoteRequestParams.get(id) : undefined;
  if (id) {
    bridge.pendingRemoteRequestMethods.delete(id);
    bridge.pendingRemoteRequestParams.delete(id);
  }

  const result =
    message.error !== undefined
      ? undefined
      : await bridge.enrichThreadPayloadForMethod(method, message.result, params);

  bridge.emit("bridge_message", {
    type: "mcp-response",
    hostId: bridge.hostId,
    message: {
      id: message.id,
      ...(message.error !== undefined ? { error: message.error } : { result }),
    },
  });

  if (message.error === undefined) {
    bridge.scheduleSyntheticCollabHydrationNotifications(method, result);
  }
}

export async function handleMcpRequest(
  bridge: ProtocolHandlersContext,
  message: AppServerMcpRequestEnvelope,
): Promise<void> {
  if (!message.request || typeof message.request.method !== "string") {
    return;
  }

  const localResult = await bridge
    .handleLocalJsonRpcRequest(message.request.method, message.request.params)
    .catch((error) => {
      if (typeof message.request?.id === "string" || typeof message.request?.id === "number") {
        bridge.emitBridgeMessage({
          type: "mcp-response",
          hostId: bridge.hostId,
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
      bridge.emitBridgeMessage({
        type: "mcp-response",
        hostId: bridge.hostId,
        message: {
          id: message.request.id,
          result: localResult.result,
        },
      });
    }
    return;
  }

  if (typeof message.request.id === "string" || typeof message.request.id === "number") {
    bridge.pendingRemoteRequestMethods.set(String(message.request.id), message.request.method);
    bridge.pendingRemoteRequestParams.set(String(message.request.id), message.request.params);
  }

  bridge.sendJsonRpcMessage({
    id: message.request.id,
    method: message.request.method,
    params: bridge.sanitizeMcpParams(message.request.method, message.request.params),
  });
}

export async function handleMcpNotification(
  bridge: ProtocolHandlersContext,
  message: AppServerMcpNotificationEnvelope,
): Promise<void> {
  if (!message.request || typeof message.request.method !== "string") {
    return;
  }

  const localResult = await bridge.handleLocalJsonRpcRequest(
    message.request.method,
    message.request.params,
  );
  if (localResult.handled) {
    return;
  }

  bridge.sendJsonRpcMessage({
    method: message.request.method,
    params: bridge.sanitizeMcpParams(message.request.method, message.request.params),
  });
}

export async function handleMcpResponse(
  bridge: ProtocolHandlersContext,
  message: AppServerMcpResponseEnvelope,
): Promise<void> {
  const response = message.response ?? message.message;
  if (!response || (typeof response.id !== "string" && typeof response.id !== "number")) {
    return;
  }

  bridge.sendJsonRpcMessage({
    id: response.id,
    ...(response.error !== undefined ? { error: response.error } : { result: response.result }),
  });
}

export async function handleThreadArchive(
  bridge: ProtocolHandlersContext,
  message: JsonRecord,
  method: "thread/archive" | "thread/unarchive",
): Promise<void> {
  const conversationId = typeof message.conversationId === "string" ? message.conversationId : null;
  if (!conversationId) {
    return;
  }

  try {
    await bridge.sendLocalRequest(method, { threadId: conversationId });
  } catch (error) {
    bridge.emit("error", normalizeError(error));
  }
}

export function handleThreadRoleRequest(
  bridge: ProtocolHandlersContext,
  message: TopLevelRequestMessage,
): void {
  bridge.emit("bridge_message", {
    type: "thread-role-response",
    requestId: message.requestId,
    role: "owner",
  });
}

export function handlePersistedAtomUpdate(
  bridge: ProtocolHandlersContext,
  message: PersistedAtomUpdateMessage,
): void {
  if (typeof message.key !== "string") {
    return;
  }

  if (message.deleted === true) {
    bridge.persistedAtoms.delete(message.key);
  } else {
    bridge.persistedAtoms.set(message.key, message.value);
  }

  bridge.emit("bridge_message", {
    type: "persisted-atom-updated",
    key: message.key,
    value: message.value,
    deleted: message.deleted === true,
  });

  queuePersistedAtomRegistryWrite(bridge);
}

export function queuePersistedAtomRegistryWrite(bridge: ProtocolHandlersContext): void {
  const state = Object.fromEntries(bridge.persistedAtoms);
  bridge.setPersistedAtomWritePromise(
    bridge
      .getPersistedAtomWritePromise()
      .catch(() => undefined)
      .then(async () => {
        try {
          await savePersistedAtomRegistry(bridge.persistedAtomRegistryPath, state);
        } catch (error) {
          debugLog("app-server", "failed to persist persisted atoms", {
            error: normalizeError(error).message,
            path: bridge.persistedAtomRegistryPath,
          });
        }
      }),
  );
}

export function getSharedObjectKey(message: JsonRecord): string | null {
  const candidates = [message.key, message.name, message.objectKey, message.objectName];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

export function emitSharedObjectUpdate(bridge: ProtocolHandlersContext, key: string): void {
  const value = bridge.sharedObjects.has(key) ? bridge.sharedObjects.get(key) : null;
  bridge.emitBridgeMessage({
    type: "shared-object-updated",
    key,
    value,
  });
}

export function handleSharedObjectSubscribe(
  bridge: ProtocolHandlersContext,
  message: JsonRecord,
): void {
  const key = getSharedObjectKey(message);
  if (!key) {
    return;
  }

  bridge.sharedObjectSubscriptions.add(key);
  emitSharedObjectUpdate(bridge, key);
}

export function handleSharedObjectUnsubscribe(
  bridge: ProtocolHandlersContext,
  message: JsonRecord,
): void {
  const key = getSharedObjectKey(message);
  if (!key) {
    return;
  }

  bridge.sharedObjectSubscriptions.delete(key);
}

export function handleSharedObjectSet(
  bridge: ProtocolHandlersContext,
  message: JsonRecord,
): void {
  const key = getSharedObjectKey(message);
  if (!key) {
    return;
  }

  bridge.sharedObjects.set(key, message.value ?? null);
  emitSharedObjectUpdate(bridge, key);
}
