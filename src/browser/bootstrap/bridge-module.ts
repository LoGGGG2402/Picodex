import type {
  BrowserToServerEnvelope,
  ServerToBrowserEnvelope,
} from "../../core/protocol.js";
import type {
  BootstrapScriptConfig,
  ElectronBridge,
  FilesState,
  SessionValidationResult,
  WorkerMessageListener,
} from "./types.js";

export function installBootstrapBridgeModule(args: {
  config: BootstrapScriptConfig;
  filesState: FilesState;
  showNotice: (message: string) => void;
  setConnectionStatus: (message: string, options?: { mode?: string }) => void;
  clearConnectionStatus: () => void;
  reloadStylesheet: (href: string) => void;
  observePocodexThemeHostFetch: (message: Record<string, unknown>) => void;
  observePocodexThemeHostFetchResponse: (message: Record<string, unknown>) => void;
  syncPocodexThemeFromPersistedAtomState: (state: Record<string, unknown>) => void;
  syncPocodexThemeFromPersistedAtomUpdate: (key: unknown, value: unknown) => void;
  openDesktopImportDialog: (mode: "first-run" | "manual") => Promise<void>;
  maybePromptForDesktopImport: () => Promise<void>;
  openManualFilePickerDialog: (title: string) => Promise<unknown[]>;
  refreshWorkspaceFileRoots: () => Promise<void>;
  revealWorkspaceFile: (path: string) => Promise<void>;
  isMobileSidebarViewport: () => boolean;
}): {
  dispatchHostMessage: (message: unknown) => void;
} {
  const {
    config,
    filesState,
    showNotice,
    setConnectionStatus,
    clearConnectionStatus,
    reloadStylesheet,
    observePocodexThemeHostFetch,
    observePocodexThemeHostFetchResponse,
    syncPocodexThemeFromPersistedAtomState,
    syncPocodexThemeFromPersistedAtomUpdate,
    openDesktopImportDialog,
    maybePromptForDesktopImport,
    openManualFilePickerDialog,
    refreshWorkspaceFileRoots,
    revealWorkspaceFile,
    isMobileSidebarViewport,
  } = args;

  const TOKEN_STORAGE_KEY = "__pocodex_token";
  const RETRY_DELAYS_MS = [1000, 2000, 5000] as const;
  const SESSION_CHECK_PATH = "/session-check";
  const workerSubscribers = new Map<string, Set<WorkerMessageListener>>();
  const pendingAppearanceThemeFetchRequestIds = new Set<string>();
  const pendingMessages: string[] = [];

  let socket: WebSocket | null = null;
  let isConnecting = false;
  let reconnectAttempt = 0;
  let isClosing = false;
  let hasConnected = false;
  function dispatchHostMessage(message: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  function rewriteOutgoingBridgeMessage(message: unknown): unknown {
    if (!isRecord(message) || message.type !== "mcp-request") {
      return message;
    }

    const request = isRecord(message.request) ? message.request : null;
    if (!request || request.method !== "thread/list") {
      return message;
    }

    const params = isRecord(request.params) ? request.params : null;
    if (!params || !("sourceKinds" in params)) {
      return message;
    }

    const rewrittenParams = {
      ...params,
    };
    delete rewrittenParams.sourceKinds;

    return {
      ...message,
      request: {
        ...request,
        params: rewrittenParams,
      },
    };
  }

  async function handleLocalHostFetch(message: Record<string, unknown>): Promise<boolean> {
    observePocodexThemeHostFetch(message);

    if (message.type !== "fetch" || typeof message.requestId !== "string") {
      return false;
    }

    if (message.url === "vscode://codex/pick-files") {
      try {
        const body = parseHostFetchBody(message.body);
        const params = isRecord(body.params) ? body.params : body;
        const pickerTitle =
          isRecord(params) && typeof params.pickerTitle === "string" && params.pickerTitle.trim()
            ? params.pickerTitle
            : "Select files";
        const files = await openManualFilePickerDialog(pickerTitle);
        dispatchHostMessage({
          type: "fetch-response",
          requestId: message.requestId,
          responseType: "success",
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          bodyJsonString: JSON.stringify({
            files,
          }),
        });
      } catch (error) {
        dispatchHostMessage({
          type: "fetch-response",
          requestId: message.requestId,
          responseType: "error",
          status: 500,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return true;
    }

    if (message.url === "vscode://codex/open-file") {
      try {
        const body = parseHostFetchBody(message.body);
        const params = isRecord(body.params) ? body.params : body;
        const path = isRecord(params) && typeof params.path === "string" ? params.path.trim() : "";
        if (!path) {
          throw new Error("File path is required.");
        }

        await revealWorkspaceFile(path);
        dispatchHostMessage({
          type: "fetch-response",
          requestId: message.requestId,
          responseType: "success",
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          bodyJsonString: JSON.stringify({ opened: true, path }),
        });
      } catch (error) {
        dispatchHostMessage({
          type: "fetch-response",
          requestId: message.requestId,
          responseType: "error",
          status: 500,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return true;
    }

    return false;
  }

  function parseHostFetchBody(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        return isRecord(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    return isRecord(value) ? value : {};
  }

  function rewriteBridgeMessageForViewport(message: unknown): unknown {
    if (!isMobileSidebarViewport() || !isRecord(message) || typeof message.type !== "string") {
      return message;
    }

    if (message.type === "persisted-atom-sync") {
      const state = isRecord(message.state) ? { ...message.state } : {};
      state["enter-behavior"] = "newline";
      return {
        ...message,
        state,
      };
    }

    if (message.type === "persisted-atom-updated" && message.key === "enter-behavior") {
      return {
        ...message,
        value: "newline",
        deleted: false,
      };
    }

    return message;
  }

  function handlePocodexBridgeMessage(message: unknown): boolean {
    if (!isRecord(message) || typeof message.type !== "string") {
      return false;
    }

    observePocodexThemeHostFetchResponse(message);

    if (message.type === "persisted-atom-sync") {
      syncPocodexThemeFromPersistedAtomState(
        isRecord(message.state) ? (message.state as Record<string, unknown>) : {},
      );
      return false;
    }

    if (message.type === "persisted-atom-updated") {
      syncPocodexThemeFromPersistedAtomUpdate(message.key, message.value);
      return false;
    }

    if (message.type === "pocodex-open-desktop-import-dialog") {
      const mode = message.mode === "first-run" ? "first-run" : "manual";
      void openDesktopImportDialog(mode);
      return true;
    }

    if (
      message.type === "workspace-root-options-updated" ||
      message.type === "active-workspace-roots-updated"
    ) {
      if (filesState.open) {
        void refreshWorkspaceFileRoots();
      }
      return false;
    }

    return false;
  }

  function getStoredToken(): string {
    const url = new URL(window.location.href);
    const tokenFromQuery = url.searchParams.get("token");
    if (tokenFromQuery) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, tokenFromQuery);
      return tokenFromQuery;
    }
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  }

  function getSocketUrl(token: string): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}/session`);
    if (token) {
      url.searchParams.set("token", token);
    }
    return url.toString();
  }

  function getSessionCheckUrl(token: string): string {
    const url = new URL(SESSION_CHECK_PATH, window.location.href);
    if (token) {
      url.searchParams.set("token", token);
    }
    return `${url.pathname}${url.search}`;
  }

  async function validateSessionToken(token: string): Promise<SessionValidationResult> {
    try {
      const response = await window.fetch(getSessionCheckUrl(token), {
        cache: "no-store",
        credentials: "same-origin",
      });

      if (response.ok) {
        return { ok: true };
      }
      if (response.status === 401) {
        return { ok: false, reason: "unauthorized" };
      }
      return { ok: false, reason: "unavailable" };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  function scheduleReconnect(message: string): void {
    const delay = RETRY_DELAYS_MS[Math.min(reconnectAttempt, RETRY_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    setConnectionStatus(message);
    window.setTimeout(() => {
      void connectSocket();
    }, delay);
  }

  function flushPendingMessages(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      if (message === undefined) {
        return;
      }
      socket.send(message);
    }
  }

  function sendEnvelope(envelope: BrowserToServerEnvelope): void {
    const serialized = JSON.stringify(envelope);
    if (!socket) {
      pendingMessages.push(serialized);
      void connectSocket();
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) {
      pendingMessages.push(serialized);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      pendingMessages.push(serialized);
      void connectSocket();
      return;
    }
    socket.send(serialized);
  }

  function publishFocusState(): void {
    sendEnvelope({
      type: "focus_state",
      isFocused: document.visibilityState === "visible" && document.hasFocus(),
    });
  }

  async function connectSocket(): Promise<void> {
    const isSocketActive =
      socket !== null &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
    if (isClosing || isConnecting || isSocketActive) {
      return;
    }

    const token = getStoredToken();
    isConnecting = true;
    setConnectionStatus(hasConnected ? "Reconnecting to Pocodex..." : "Connecting to Pocodex...");

    const validation = await validateSessionToken(token);
    if (!validation.ok) {
      isConnecting = false;
      if (validation.reason === "unauthorized") {
        setConnectionStatus(
          token
            ? "Pocodex rejected this token. Open the exact URL printed by the CLI for the current run."
            : "Pocodex requires a token. Open the exact URL printed by the CLI for the current run.",
        );
        return;
      }
      scheduleReconnect("Pocodex is unavailable. Retrying...");
      return;
    }

    socket = new WebSocket(getSocketUrl(token));
    socket.addEventListener("open", () => {
      isConnecting = false;
      reconnectAttempt = 0;
      const shouldReload = hasConnected;
      hasConnected = true;
      clearConnectionStatus();
      flushPendingMessages();
      publishFocusState();
      for (const workerName of workerSubscribers.keys()) {
        sendEnvelope({ type: "worker_subscribe", workerName });
      }
      if (!shouldReload) {
        window.setTimeout(() => {
          void maybePromptForDesktopImport();
        }, 250);
      }
      if (shouldReload) {
        window.location.reload();
      }
    });

    socket.addEventListener("error", () => {
      if (!hasConnected) {
        setConnectionStatus(
          "Pocodex could not open its live session. Check the CLI output and the page token.",
        );
      }
    });

    socket.addEventListener("message", (event) => {
      const envelope = parseServerEnvelope(event.data);
      if (!envelope) {
        showNotice("Pocodex received invalid server data.");
        return;
      }

      switch (envelope.type) {
        case "bridge_message":
          {
            const bridgeMessage = rewriteBridgeMessageForViewport(envelope.message);
            if (handlePocodexBridgeMessage(bridgeMessage)) {
              break;
            }
            dispatchHostMessage(bridgeMessage);
          }
          break;
        case "worker_message": {
          const listeners = workerSubscribers.get(envelope.workerName);
          listeners?.forEach((listener) => listener(envelope.message));
          break;
        }
        case "client_notice":
          showNotice(envelope.message);
          break;
        case "css_reload":
          reloadStylesheet(envelope.href);
          break;
        case "session_revoked":
          showNotice(envelope.reason || "This Pocodex session is no longer available.");
          setConnectionStatus(envelope.reason || "This Pocodex session is no longer available.");
          isClosing = true;
          socket?.close(4001, "revoked");
          break;
        case "error":
          showNotice(envelope.message);
          break;
      }
    });

    socket.addEventListener("close", () => {
      const shouldReconnect = !isClosing;
      socket = null;
      isConnecting = false;
      if (!shouldReconnect) {
        return;
      }
      showNotice("Pocodex lost the host connection. Retrying...");
      scheduleReconnect("Pocodex lost the host connection. Retrying...");
    });
  }

  function parseServerEnvelope(data: unknown): ServerToBrowserEnvelope | null {
    try {
      const parsed = JSON.parse(String(data)) as unknown;
      return isServerToBrowserEnvelope(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function isServerToBrowserEnvelope(value: unknown): value is ServerToBrowserEnvelope {
    if (!isRecord(value) || typeof value.type !== "string") {
      return false;
    }

    switch (value.type) {
      case "bridge_message":
        return "message" in value;
      case "worker_message":
        return typeof value.workerName === "string" && "message" in value;
      case "client_notice":
        return typeof value.message === "string";
      case "css_reload":
        return typeof value.href === "string";
      case "session_revoked":
        return typeof value.reason === "string";
      case "error":
        return typeof value.message === "string";
      default:
        return false;
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function isHtmlButtonElement(value: unknown): value is HTMLButtonElement {
    return typeof HTMLButtonElement !== "undefined" && value instanceof HTMLButtonElement;
  }

  function isHtmlDivElement(value: unknown): value is HTMLDivElement {
    return typeof HTMLDivElement !== "undefined" && value instanceof HTMLDivElement;
  }

  function isHtmlIFrameElement(value: unknown): value is HTMLIFrameElement {
    return typeof HTMLIFrameElement !== "undefined" && value instanceof HTMLIFrameElement;
  }

  function addWorkerSubscriber(workerName: string, callback: WorkerMessageListener): () => void {
    let listeners = workerSubscribers.get(workerName);
    if (!listeners) {
      listeners = new Set<WorkerMessageListener>();
      workerSubscribers.set(workerName, listeners);
      sendEnvelope({ type: "worker_subscribe", workerName });
    }

    listeners.add(callback);
    return () => {
      const currentListeners = workerSubscribers.get(workerName);
      if (!currentListeners) {
        return;
      }
      currentListeners.delete(callback);
      if (currentListeners.size === 0) {
        workerSubscribers.delete(workerName);
        sendEnvelope({ type: "worker_unsubscribe", workerName });
      }
    };
  }

  const electronBridge: ElectronBridge = {
    windowType: "electron",
    sendMessageFromView: async (message) => {
      if (isRecord(message) && message.type === "electron-window-focus-request") {
        dispatchHostMessage({
          type: "electron-window-focus-changed",
          isFocused: document.visibilityState === "visible" && document.hasFocus(),
        });
        return;
      }
      if (isRecord(message) && (await handleLocalHostFetch(message))) {
        return;
      }
      sendEnvelope({ type: "bridge_message", message: rewriteOutgoingBridgeMessage(message) });
    },
    getPathForFile: (_file) => null,
    sendWorkerMessageFromView: async (workerName, message) => {
      sendEnvelope({ type: "worker_message", workerName, message });
    },
    subscribeToWorkerMessages: (workerName, callback) => addWorkerSubscriber(workerName, callback),
    showContextMenu: async () => {
      showNotice("Context menus are not available in Pocodex.");
    },
    getFastModeRolloutMetrics: async () => ({}),
    triggerSentryTestError: async () => {},
    getSentryInitOptions: () => config.sentryOptions,
    getAppSessionId: () => config.sentryOptions.codexAppSessionId,
    getBuildFlavor: () => config.sentryOptions.buildFlavor,
  };

  const nativeFetch: typeof window.fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.startsWith("sentry-ipc://")) {
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === "vscode://codex/ipc-request") {
      const method =
        init?.method ??
        (input instanceof Request ? (input as Request & { method?: string }).method : undefined) ??
        "POST";
      return nativeFetch("/ipc-request", {
        method,
        body: init?.body,
        headers: init?.headers,
        cache: "no-store",
        credentials: "same-origin",
      });
    }
    return nativeFetch(input, init);
  };

  Object.defineProperty(window, "codexWindowType", {
    value: "electron",
    configurable: false,
    enumerable: true,
    writable: false,
  });
  Object.defineProperty(window, "electronBridge", {
    value: electronBridge,
    configurable: false,
    enumerable: true,
    writable: false,
  });

  window.addEventListener("focus", publishFocusState);
  window.addEventListener("blur", publishFocusState);
  document.addEventListener("visibilitychange", publishFocusState);
  window.addEventListener(
    "beforeunload",
    () => {
      isClosing = true;
      if (socket) {
        socket.close(1000, "unload");
      }
    },
    { once: true },
  );

  void connectSocket();

  return {
    dispatchHostMessage,
  };
}
