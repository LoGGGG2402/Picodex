import type {
  BrowserToServerEnvelope,
  SentryInitOptions,
  ServerToBrowserEnvelope,
} from "./protocol.js";
import { serializeInlineScript } from "./inline-script.js";

export interface BootstrapScriptConfig {
  sentryOptions: SentryInitOptions;
  stylesheetHref: string;
  highlightModuleHref?: string;
  importIconSvg?: string;
}

export function renderBootstrapScript(config: BootstrapScriptConfig): string {
  return serializeInlineScript(bootstrapPocodexInBrowser, config);
}

function bootstrapPocodexInBrowser(config: BootstrapScriptConfig): void {
  type ConnectionStatusOptions = {
    mode?: string;
  };

  type DesktopImportMode = "first-run" | "manual";

  type DesktopImportProject = {
    root: string;
    label: string;
    activeInCodex: boolean;
    alreadyImported: boolean;
    available: boolean;
  };

  type DesktopImportListResult = {
    found: boolean;
    path: string;
    promptSeen: boolean;
    shouldPrompt: boolean;
    projects: DesktopImportProject[];
  };

  type HostResolvedFile = {
    label: string;
    path: string;
    fsPath: string;
  };

  type HostDirectoryEntry = {
    name: string;
    path: string;
    kind: "directory" | "file";
  };

  type WorkspaceFileRoot = {
    path: string;
    label: string;
    active: boolean;
  };

  type WorkspaceFileEntry = {
    name: string;
    path: string;
    relativePath: string;
    kind: "directory" | "file";
  };

  type WorkspaceFileReadResult =
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

  type WorkspaceFileSearchResult = {
    root: string;
    path: string;
    relativePath: string;
  };

  type HighlightCodeModule = {
    highlightCode: (
      code: string,
      language?: string,
    ) => {
      html: string;
      language?: string;
    };
  };

  type SessionValidationResult =
    | { ok: true }
    | { ok: false; reason: "unauthorized" | "unavailable" };

  type WorkerMessageListener = (message: unknown) => void;

  interface ElectronBridge {
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

  const POCODEX_STYLESHEET_ID = "pocodex-stylesheet";
  const TOKEN_STORAGE_KEY = "__pocodex_token";
  const RETRY_DELAYS_MS = [1000, 2000, 5000] as const;
  const SESSION_CHECK_PATH = "/session-check";
  const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 640px), (pointer: coarse) and (max-width: 900px)";
  const APPEARANCE_THEME_VALUES = new Set(["light", "dark", "system"]);
  const POCODEX_SETTINGS_EMBED_QUERY_PARAM = "pocodexEmbed";
  const POCODEX_SETTINGS_EMBED_VALUE = "settings-modal";
  const FILES_DRAWER_DEFAULT_MAX_WIDTH_PX = 1280;
  const FILES_DRAWER_DEFAULT_VIEWPORT_RATIO = 0.72;
  const FILES_DRAWER_MAX_VIEWPORT_RATIO = 0.92;
  const FILES_DRAWER_VIEWPORT_MARGIN_PX = 64;
  const FILES_DRAWER_HORIZONTAL_PADDING_PX = 48;
  const FILES_EXPLORER_MIN_WIDTH_PX = 240;
  const FILES_PREVIEW_MIN_WIDTH_PX = 320;
  const FILES_EXPLORER_RESIZE_HANDLE_WIDTH_PX = 12;
  const WORKSPACE_PREVIEW_HIGHLIGHT_MAX_CHARACTERS = 200_000;
  const WORKSPACE_PREVIEW_AUTO_HIGHLIGHT_MAX_CHARACTERS = 60_000;
  const WORKSPACE_PREVIEW_HIGHLIGHT_CACHE_LIMIT = 12;
  const BACKGROUND_SUBAGENTS_STATSIG_GATE = "1221508807";
  const POCODEX_STATSIG_CLASS_PATCH_MARK = "__pocodexBackgroundSubagentsPatched";
  const POCODEX_STATSIG_INSTANCE_PATCH_MARK = "__pocodexBackgroundSubagentsInstancePatched";
  const workerSubscribers = new Map<string, Set<WorkerMessageListener>>();
  const pendingAppearanceThemeFetchRequestIds = new Set<string>();
  const pendingMessages: string[] = [];
  const workspacePreviewHighlightCache = new Map<
    string,
    { html: string; language: string }
  >();
  const toastHost = document.createElement("div");
  const statusHost = document.createElement("div");
  const importHost = document.createElement("div");
  const filesHost = document.createElement("div");
  const settingsModalHost = document.createElement("div");

  let socket: WebSocket | null = null;
  let isConnecting = false;
  let reconnectAttempt = 0;
  let isClosing = false;
  let isOpenInAppObserverStarted = false;
  let isImportUiObserverStarted = false;
  let isFilesUiObserverStarted = false;
  let isNativeSettingsOverrideInstalled = false;
  let hasConnected = false;
  let hasAttemptedDesktopImportPrompt = false;
  let settingsModalKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
  let nextIpcRequestId = 0;
  let filesSearchTimeoutId: number | null = null;
  let filesSearchRevision = 0;
  let pocodexThemePreference: "light" | "dark" | "system" = "system";
  let workspacePreviewHighlighterPromise: Promise<HighlightCodeModule | null> | null = null;

  const filesState = {
    open: false,
    roots: [] as WorkspaceFileRoot[],
    selectedRoot: null as string | null,
    selectedFilePath: null as string | null,
    previewPath: null as string | null,
    previewRelativePath: "",
    previewKind: null as "text" | "image" | "pdf" | "binary" | null,
    previewMimeType: "",
    previewSizeBytes: 0,
    previewContents: "",
    previewObjectUrl: null as string | null,
    previewHighlightedHtml: "",
    previewHighlightedLanguage: "",
    previewHighlighting: false,
    previewHighlightRevision: 0,
    previewLoading: false,
    isRefreshing: false,
    searchQuery: "",
    searchResults: [] as WorkspaceFileSearchResult[],
    searchLoading: false,
    status: "Choose a file from the explorer.",
    drawerWidthPx: null as number | null,
    explorerWidthPx: null as number | null,
    directoryEntries: new Map<string, WorkspaceFileEntry[]>(),
    expandedDirectories: new Set<string>(),
    loadingDirectories: new Set<string>(),
  };

  toastHost.id = "pocodex-toast-host";
  statusHost.id = "pocodex-status-host";
  importHost.id = "pocodex-import-host";
  filesHost.id = "pocodex-files-host";
  settingsModalHost.id = "pocodex-settings-modal-host";
  importHost.hidden = true;
  filesHost.hidden = true;
  settingsModalHost.hidden = true;
  document.documentElement.dataset.pocodex = "true";
  installStatsigBackgroundSubagentsOverride();

  runWhenDocumentReady(() => {
    ensureStylesheetLink(config.stylesheetHref);
    applyPocodexThemePreference("system");
    installPocodexSystemThemeListener();
    ensureHostAttached(toastHost);
    ensureHostAttached(statusHost);
    ensureHostAttached(importHost);
    ensureHostAttached(filesHost);
    ensureHostAttached(settingsModalHost);
    startOpenInAppObserver();
    startImportUiObserver();
    startFilesUiObserver();
    if (isEmbeddedSettingsView()) {
      installEmbeddedSettingsChromeCleanup();
    } else {
      removeInjectedSettingsButtons();
      installNativeSettingsOverride();
    }
    installMobileSidebarThreadNavigationClose();
  });

  function installStatsigBackgroundSubagentsOverride(): void {
    const host = globalThis as typeof globalThis & {
      __STATSIG__?: Record<string, unknown>;
    };
    const statsigGlobal =
      host.__STATSIG__ && typeof host.__STATSIG__ === "object" ? host.__STATSIG__ : {};
    host.__STATSIG__ = statsigGlobal;

    let statsigClientValue = patchStatsigClientClass(statsigGlobal.StatsigClient);
    patchStatsigInstances(statsigGlobal);

    Object.defineProperty(statsigGlobal, "StatsigClient", {
      configurable: true,
      enumerable: true,
      get: () => statsigClientValue,
      set: (value: unknown) => {
        statsigClientValue = patchStatsigClientClass(value);
        patchStatsigInstances(statsigGlobal);
      },
    });
  }

  function patchStatsigClientClass(value: unknown): unknown {
    if (typeof value !== "function") {
      return value;
    }

    const statsigClientClass = value as (Function & {
      prototype?: Record<string, unknown>;
      [POCODEX_STATSIG_CLASS_PATCH_MARK]?: boolean;
    });
    if (statsigClientClass[POCODEX_STATSIG_CLASS_PATCH_MARK]) {
      return value;
    }

    const prototype =
      statsigClientClass.prototype && typeof statsigClientClass.prototype === "object"
        ? statsigClientClass.prototype
        : null;
    if (!prototype) {
      return value;
    }

    patchStatsigClientLike(prototype, POCODEX_STATSIG_CLASS_PATCH_MARK);
    statsigClientClass[POCODEX_STATSIG_CLASS_PATCH_MARK] = true;
    return value;
  }

  function patchStatsigInstances(statsigGlobal: Record<string, unknown>): void {
    patchStatsigClientLike(statsigGlobal.firstInstance, POCODEX_STATSIG_INSTANCE_PATCH_MARK);

    const instances =
      statsigGlobal.instances && typeof statsigGlobal.instances === "object"
        ? statsigGlobal.instances
        : null;
    if (!instances) {
      return;
    }

    for (const instance of Object.values(instances)) {
      patchStatsigClientLike(instance, POCODEX_STATSIG_INSTANCE_PATCH_MARK);
    }
  }

  function patchStatsigClientLike(target: unknown, markKey: string): void {
    if (!target || typeof target !== "object") {
      return;
    }

    const client = target as Record<string, unknown> & { [key: string]: unknown };
    if (client[markKey] === true) {
      return;
    }

    const originalCheckGate = typeof client.checkGate === "function" ? client.checkGate : null;
    if (originalCheckGate) {
      client.checkGate = function (this: unknown, gateName: unknown, ...args: unknown[]) {
        if (gateName === BACKGROUND_SUBAGENTS_STATSIG_GATE) {
          return true;
        }
        return originalCheckGate.apply(this, [gateName, ...args]);
      };
    }

    const originalGetFeatureGate =
      typeof client.getFeatureGate === "function" ? client.getFeatureGate : null;
    if (originalGetFeatureGate) {
      client.getFeatureGate = function (this: unknown, gateName: unknown, ...args: unknown[]) {
        const result = originalGetFeatureGate.apply(this, [gateName, ...args]);
        if (gateName !== BACKGROUND_SUBAGENTS_STATSIG_GATE) {
          return result;
        }
        if (result && typeof result === "object") {
          return {
            ...(result as Record<string, unknown>),
            value: true,
          };
        }
        return {
          name: BACKGROUND_SUBAGENTS_STATSIG_GATE,
          value: true,
        };
      };
    }

    client[markKey] = true;
  }

  function runWhenDocumentReady(callback: () => void): void {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function ensureHostAttached(host: HTMLDivElement): void {
    if (!document.body) {
      runWhenDocumentReady(() => {
        ensureStylesheetLink(config.stylesheetHref);
        ensureHostAttached(host);
      });
      return;
    }
    if (!document.body.contains(host)) {
      document.body.appendChild(host);
    }
  }

  function ensureStylesheetLink(href?: string): HTMLLinkElement | null {
    const head = document.head ?? document.getElementsByTagName("head")[0];
    if (!head) {
      return null;
    }

    const current = document.getElementById(POCODEX_STYLESHEET_ID);
    let link = current instanceof HTMLLinkElement ? current : null;
    if (!link) {
      if (!href) {
        return null;
      }
      link = document.createElement("link");
      link.id = POCODEX_STYLESHEET_ID;
      link.rel = "stylesheet";
      head.appendChild(link);
    }

    if (href) {
      link.href = href;
    }

    return link;
  }

  function revokeWorkspacePreviewObjectUrl(): void {
    if (!filesState.previewObjectUrl || typeof URL === "undefined") {
      filesState.previewObjectUrl = null;
      return;
    }

    URL.revokeObjectURL(filesState.previewObjectUrl);
    filesState.previewObjectUrl = null;
  }

  function resetWorkspacePreviewState(options: { keepPath?: boolean } = {}): void {
    revokeWorkspacePreviewObjectUrl();

    if (!options.keepPath) {
      filesState.previewPath = null;
      filesState.previewRelativePath = "";
    }

    filesState.previewKind = null;
    filesState.previewMimeType = "";
    filesState.previewSizeBytes = 0;
    filesState.previewContents = "";
    filesState.previewHighlightedHtml = "";
    filesState.previewHighlightedLanguage = "";
    filesState.previewHighlighting = false;
    filesState.previewHighlightRevision += 1;
  }

  function installPocodexSystemThemeListener(): void {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (pocodexThemePreference === "system") {
        applyPocodexThemePreference("system");
      }
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return;
    }

    if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(handleChange);
    }
  }

  function reloadStylesheet(href: string): void {
    const currentLink = ensureStylesheetLink();
    if (!currentLink) {
      ensureStylesheetLink(href);
      return;
    }

    const nextLink = document.createElement("link");
    nextLink.id = POCODEX_STYLESHEET_ID;
    nextLink.rel = "stylesheet";
    nextLink.href = href;
    nextLink.addEventListener(
      "load",
      () => {
        currentLink.remove();
      },
      { once: true },
    );
    nextLink.addEventListener(
      "error",
      () => {
        nextLink.remove();
        showNotice("Failed to reload Pocodex CSS.");
      },
      { once: true },
    );
    currentLink.after(nextLink);
  }

  function showNotice(message: string): void {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.dataset.pocodexToast = "true";
    ensureHostAttached(toastHost);
    toastHost.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 5000);
  }

  function applyPocodexThemePreference(preference: "light" | "dark" | "system"): void {
    pocodexThemePreference = preference;
    const variant = resolvePocodexThemeVariant(preference);
    document.documentElement.dataset.pocodexThemeVariant = variant;
    const rootStyle =
      typeof document.documentElement === "object" &&
      document.documentElement !== null &&
      "style" in document.documentElement
        ? document.documentElement.style
        : null;
    if (rootStyle && typeof rootStyle === "object" && "colorScheme" in rootStyle) {
      rootStyle.colorScheme = variant;
    }
  }

  function resolvePocodexThemeVariant(preference: "light" | "dark" | "system"): "light" | "dark" {
    if (preference === "light" || preference === "dark") {
      return preference;
    }

    if (typeof window.matchMedia !== "function") {
      return "light";
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function syncPocodexThemeFromPersistedAtomState(state: Record<string, unknown>): void {
    const preference = extractPocodexThemePreferenceFromEntries(Object.entries(state));
    if (preference) {
      applyPocodexThemePreference(preference);
    }
  }

  function syncPocodexThemeFromPersistedAtomUpdate(key: unknown, value: unknown): void {
    if (typeof key !== "string") {
      return;
    }

    const preference = extractPocodexThemePreferenceFromEntries([[key, value]]);
    if (preference) {
      applyPocodexThemePreference(preference);
    }
  }

  function syncPocodexThemeFromGlobalStateValue(value: unknown): void {
    const preference = normalizePocodexThemePreference(value);
    if (preference) {
      applyPocodexThemePreference(preference);
    }
  }

  function observePocodexThemeHostFetch(message: Record<string, unknown>): void {
    if (message.type !== "fetch" || typeof message.url !== "string") {
      return;
    }

    if (
      message.url !== "vscode://codex/get-global-state" &&
      message.url !== "vscode://codex/set-global-state" &&
      message.url !== "vscode://codex/get-configuration" &&
      message.url !== "vscode://codex/set-configuration"
    ) {
      return;
    }

    const body = parseHostFetchBody(message.body);
    if (body.key !== "appearanceTheme") {
      return;
    }

    if (
      message.url === "vscode://codex/get-global-state" ||
      message.url === "vscode://codex/get-configuration"
    ) {
      if (typeof message.requestId === "string") {
        pendingAppearanceThemeFetchRequestIds.add(message.requestId);
      }
      return;
    }

    syncPocodexThemeFromGlobalStateValue(body.value);
  }

  function observePocodexThemeHostFetchResponse(message: Record<string, unknown>): void {
    if (
      message.type !== "fetch-response" ||
      typeof message.requestId !== "string" ||
      !pendingAppearanceThemeFetchRequestIds.has(message.requestId)
    ) {
      return;
    }

    pendingAppearanceThemeFetchRequestIds.delete(message.requestId);

    if (message.responseType !== "success" || typeof message.bodyJsonString !== "string") {
      return;
    }

    const body = parseHostFetchBody(message.bodyJsonString);
    syncPocodexThemeFromGlobalStateValue(body.value);
  }

  function extractPocodexThemePreferenceFromEntries(
    entries: Array<[string, unknown]>,
  ): "light" | "dark" | "system" | null {
    for (const [key, value] of entries) {
      const preference = normalizePocodexThemePreference(value);
      if (!preference) {
        continue;
      }

      const normalizedKey = key.trim().toLowerCase();
      if (
        normalizedKey === "appearancetheme" ||
        normalizedKey === "appearance-theme" ||
        normalizedKey === "theme" ||
        normalizedKey.includes("theme-variant")
      ) {
        return preference;
      }
    }

    return null;
  }

  function normalizePocodexThemePreference(value: unknown): "light" | "dark" | "system" | null {
    const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!APPEARANCE_THEME_VALUES.has(normalizedValue)) {
      return null;
    }

    return normalizedValue as "light" | "dark" | "system";
  }

  function setConnectionStatus(message: string, options: ConnectionStatusOptions = {}): void {
    ensureHostAttached(statusHost);
    statusHost.replaceChildren();
    statusHost.dataset.mode = options.mode ?? "blocking";
    statusHost.hidden = false;

    const card = document.createElement("div");
    card.dataset.pocodexStatusCard = "true";

    const title = document.createElement("strong");
    title.textContent = "Pocodex";

    const body = document.createElement("p");
    body.textContent = message;

    card.append(title, body);
    statusHost.appendChild(card);
  }

  function clearConnectionStatus(): void {
    statusHost.hidden = true;
    delete statusHost.dataset.mode;
    statusHost.replaceChildren();
  }

  function installMobileSidebarThreadNavigationClose(): void {
    document.addEventListener("click", handleMobileSidebarThreadClick, true);
    document.addEventListener("click", handleMobileContentPaneClick, true);
  }

  function handleMobileSidebarThreadClick(event: MouseEvent): void {
    if (!isMobileSidebarViewport() || !isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const navigation = target.closest('nav[role="navigation"]');
    if (!navigation) {
      return;
    }

    const nearestInteractive = target.closest(
      'button, a, input, select, textarea, [role="button"], [role="menuitem"]',
    );
    if (!nearestInteractive || !navigation.contains(nearestInteractive)) {
      return;
    }

    if (
      isMobileSidebarThreadRow(nearestInteractive) ||
      isMobileSidebarNewThreadTrigger(nearestInteractive)
    ) {
      scheduleMobileSidebarClose();
    }
  }

  function isMobileSidebarThreadRow(element: Element): boolean {
    if (
      element.tagName === "BUTTON" ||
      element.getAttribute("role") !== "button" ||
      !element.closest('nav[role="navigation"]')
    ) {
      return false;
    }

    if (element.querySelector("[data-thread-title]")) {
      return true;
    }

    if (!element.closest('[role="listitem"]')) {
      return false;
    }

    const buttons = element.querySelectorAll("button");
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons.item(index);
      const ariaLabel = button?.getAttribute("aria-label");
      if (ariaLabel === "Archive thread" || ariaLabel === "Unarchive thread") {
        return true;
      }
    }

    return false;
  }

  function isMobileSidebarNewThreadTrigger(element: Element): boolean {
    if (
      !element.closest('nav[role="navigation"]') ||
      (element.tagName !== "BUTTON" && element.tagName !== "A")
    ) {
      return false;
    }

    const ariaLabel = element.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (ariaLabel === "new thread" || ariaLabel.startsWith("start new thread in ")) {
      return true;
    }

    const text = element.textContent?.trim().toLowerCase() ?? "";
    return text === "new thread";
  }

  function handleMobileContentPaneClick(event: MouseEvent): void {
    if (!isMobileSidebarViewport() || !isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest('nav[role="navigation"]') || !target.closest(".main-surface")) {
      return;
    }

    if (!isMobileSidebarOpen()) {
      return;
    }

    scheduleMobileSidebarClose();
  }

  function scheduleMobileSidebarClose(): void {
    window.setTimeout(() => {
      if (isMobileSidebarViewport() && isMobileSidebarOpen()) {
        dispatchHostMessage({ type: "toggle-sidebar" });
      }
    }, 0);
  }

  function isMobileSidebarOpen(): boolean {
    const contentPane = document.querySelector(".main-surface");
    if (!(contentPane instanceof Element)) {
      return false;
    }

    const style = (
      contentPane as Element & {
        style?: { width?: string; transform?: string };
      }
    ).style;
    const width = typeof style?.width === "string" ? style.width.trim() : "";
    if (width !== "" && width !== "100%") {
      return true;
    }

    const transform = typeof style?.transform === "string" ? style.transform.trim() : "";
    if (transform !== "" && transform !== "translateX(0)" && transform !== "translateX(0px)") {
      return true;
    }

    return isMobileSidebarOpenByGeometry(contentPane);
  }

  function isMobileSidebarOpenByGeometry(contentPane: Element): boolean {
    if (typeof contentPane.getBoundingClientRect !== "function") {
      return false;
    }

    const viewportWidth = typeof window.innerWidth === "number" ? window.innerWidth : 0;
    const rect = contentPane.getBoundingClientRect();
    if (rect.left > 0.5) {
      return true;
    }

    if (viewportWidth > 0 && rect.width > 0 && rect.width < viewportWidth - 0.5) {
      return true;
    }

    const navigation = document.querySelector('nav[role="navigation"]');
    if (
      !(navigation instanceof Element) ||
      typeof navigation.getBoundingClientRect !== "function"
    ) {
      return false;
    }

    const navigationRect = navigation.getBoundingClientRect();
    return navigationRect.left >= -0.5 && navigationRect.right > 0.5 && navigationRect.width > 0.5;
  }

  function isMobileSidebarViewport(): boolean {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY).matches;
    }
    return window.innerWidth <= 640;
  }

  function isPrimaryUnmodifiedClick(event: MouseEvent): boolean {
    return (
      !event.defaultPrevented &&
      (event.button ?? 0) === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    );
  }

  function isOpenInAppButtonGroup(group: HTMLDivElement): boolean {
    const buttons = group.querySelectorAll(":scope > button");
    if (buttons.length !== 2) {
      return false;
    }

    const primary = buttons.item(0);
    const secondary = buttons.item(1);
    if (!primary || !secondary) {
      return false;
    }

    return Boolean(
      primary.querySelector("img.icon-sm, img") &&
      secondary.getAttribute("aria-label") === "Secondary action" &&
      secondary.getAttribute("aria-haspopup") === "menu",
    );
  }

  function tagOpenInAppButtons(root: Document | Element = document): void {
    root.querySelectorAll("div.inline-flex").forEach((group) => {
      if (!(group instanceof HTMLDivElement)) {
        return;
      }
      if (isOpenInAppButtonGroup(group)) {
        group.dataset.pocodexOpenInApp = "true";
        return;
      }
      delete group.dataset.pocodexOpenInApp;
    });
  }

  function startOpenInAppObserver(): void {
    if (isOpenInAppObserverStarted || !document.body) {
      return;
    }

    isOpenInAppObserverStarted = true;
    tagOpenInAppButtons(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }
          tagOpenInAppButtons(node);
          if (node.parentElement) {
            tagOpenInAppButtons(node.parentElement);
          }
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function startImportUiObserver(): void {
    if (isImportUiObserverStarted || !document.body) {
      return;
    }

    isImportUiObserverStarted = true;
    refreshImportUi(document);

    const observer = new MutationObserver(() => {
      refreshImportUi(document);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function refreshImportUi(root: Document | Element = document): void {
    root.querySelectorAll('[role="menu"]').forEach((candidate) => {
      if (!(candidate instanceof Element)) {
        return;
      }
      maybeInjectSettingsMenuImportItem(candidate);
    });
  }

  function startFilesUiObserver(): void {
    if (isFilesUiObserverStarted || !document.body) {
      return;
    }

    isFilesUiObserverStarted = true;
    refreshFilesUi(document);

    const observer = new MutationObserver(() => {
      refreshFilesUi(document);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function refreshFilesUi(root: Document | Element = document): void {
    maybeInjectFilesToolbarButton(root);
  }

  function removeInjectedSettingsButtons(root: Document | Element = document): void {
    root
      .querySelectorAll('[data-pocodex-header-settings="true"], [data-pocodex-floating-settings="true"]')
      .forEach((button) => {
        button.remove();
      });
  }

  function installEmbeddedSettingsChromeCleanup(): void {
    document.documentElement.dataset.pocodexEmbeddedSettingsView = "true";
    cleanupEmbeddedSettingsChrome(document);

    if (!document.body) {
      return;
    }

    const observer = new MutationObserver(() => {
      cleanupEmbeddedSettingsChrome(document);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function cleanupEmbeddedSettingsChrome(root: Document | Element): void {
    root.querySelectorAll<HTMLElement>('[role="link"], button, a').forEach((candidate) => {
      if (!shouldHideEmbeddedSettingsElement(candidate)) {
        return;
      }

      candidate.hidden = true;
      candidate.setAttribute("aria-hidden", "true");
      candidate.tabIndex = -1;
      candidate.style.display = "none";
    });
  }

  function shouldHideEmbeddedSettingsElement(element: HTMLElement): boolean {
    if (element.closest("#pocodex-settings-modal-host")) {
      return false;
    }

    const label = normalizeMenuItemText(element.getAttribute("aria-label") ?? element.textContent);
    return label === "back to app";
  }

  function installNativeSettingsOverride(): void {
    if (isNativeSettingsOverrideInstalled) {
      return;
    }

    isNativeSettingsOverrideInstalled = true;
    document.addEventListener("click", handleNativeSettingsTriggerClick, true);
  }

  function handleNativeSettingsTriggerClick(event: MouseEvent): void {
    if (!isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const trigger = target.closest('button, a, [role="menuitem"]');
    if (!(trigger instanceof Element) || !shouldOverrideNativeSettingsTrigger(trigger)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (trigger.closest('[role="menu"]')) {
      dismissActiveMenu();
    }

    openSettingsExperience("general-settings");
  }

  function shouldOverrideNativeSettingsTrigger(trigger: Element): boolean {
    if (trigger.closest("#pocodex-settings-modal-host")) {
      return false;
    }

    if (trigger instanceof HTMLElement && Object.keys(trigger.dataset).some((key) => key.startsWith("pocodex"))) {
      return false;
    }

    const label = normalizeMenuItemText(trigger.getAttribute("aria-label") ?? trigger.textContent);
    if (label !== "settings" && label !== "open settings") {
      return false;
    }

    const menu = trigger.closest('[role="menu"]');
    if (menu) {
      return looksLikeAccountMenu(menu);
    }

    return trigger.tagName === "BUTTON" || trigger.tagName === "A";
  }

  function maybeInjectFilesToolbarButton(root: Document | Element): void {
    const existingButton = root.querySelector('[data-pocodex-files-toggle="true"]');
    if (isHtmlButtonElement(existingButton)) {
      syncFilesToggleButton(existingButton);
      return;
    }

    const anchorButton = root.querySelector(
      'button[aria-label="Toggle terminal"], button[aria-label="Toggle diff panel"]',
    );
    if (!isHtmlButtonElement(anchorButton)) {
      return;
    }

    const anchorGroup = anchorButton.parentElement?.closest("div");
    if (!isHtmlDivElement(anchorGroup) || !anchorGroup.parentElement) {
      return;
    }

    const group = document.createElement("div");
    group.dataset.pocodexFilesButtonGroup = "true";
    group.className = anchorGroup.className;

    const button = anchorButton.cloneNode(true);
    if (!isHtmlButtonElement(button)) {
      return;
    }

    button.dataset.pocodexFilesToggle = "true";
    button.setAttribute("aria-label", "Toggle files panel");
    button.type = "button";
    button.innerHTML = getFilesToggleIconSvg();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleFilesPanel();
    });
    syncFilesToggleButton(button);

    group.appendChild(button);
    anchorGroup.parentElement.insertBefore(group, anchorGroup);
  }

  function syncFilesToggleButton(button: HTMLButtonElement): void {
    const state = filesState.open ? "open" : "closed";
    button.dataset.state = state;
    button.setAttribute("aria-pressed", filesState.open ? "true" : "false");
    button.classList.toggle("pocodex-files-toggle-active", filesState.open);
  }

  function syncAllFilesToggleButtons(): void {
    document.querySelectorAll('[data-pocodex-files-toggle="true"]').forEach((candidate) => {
      if (!isHtmlButtonElement(candidate)) {
        return;
      }
      syncFilesToggleButton(candidate);
    });
  }

  async function toggleFilesPanel(forceOpen?: boolean): Promise<void> {
    const shouldOpen = forceOpen ?? !filesState.open;
    if (shouldOpen === filesState.open) {
      return;
    }

    filesState.open = shouldOpen;
    syncAllFilesToggleButtons();
    if (!shouldOpen) {
      filesHost.hidden = true;
      filesHost.replaceChildren();
      return;
    }

    renderFilesPanel();
    await refreshWorkspaceFileRoots();
  }

  async function refreshWorkspaceFileRoots(): Promise<void> {
    filesState.isRefreshing = true;
    filesState.status = "Loading explorer...";
    renderFilesPanel();

    try {
      const result = await callPocodexIpc("workspace-files/list-roots");
      const roots = getWorkspaceFileRoots(result);
      const previousSelectedRoot = filesState.selectedRoot;
      filesState.roots = roots;

      const selectedRoot = roots.find((root) => root.path === filesState.selectedRoot);
      filesState.selectedRoot =
        (selectedRoot ?? roots.find((root) => root.active) ?? roots[0] ?? null)?.path ?? null;

      if (filesState.selectedRoot !== previousSelectedRoot) {
        filesState.directoryEntries.clear();
        filesState.expandedDirectories.clear();
        filesState.loadingDirectories.clear();
        filesState.selectedFilePath = null;
        resetWorkspacePreviewState();
        filesState.searchResults = [];
      }

      if (filesState.selectedRoot) {
        filesState.expandedDirectories.add(filesState.selectedRoot);
        await loadWorkspaceDirectory(filesState.selectedRoot, filesState.selectedRoot);
        if (filesState.searchQuery.trim()) {
          scheduleWorkspaceFileSearch();
        }
      } else {
        filesState.status = "No workspace roots are available.";
        resetWorkspacePreviewState();
        filesState.selectedFilePath = null;
        filesState.searchResults = [];
      }
    } catch (error) {
      filesState.status = "Failed to load explorer.";
      showNotice(error instanceof Error ? error.message : "Failed to load workspace files.");
    } finally {
      filesState.isRefreshing = false;
      renderFilesPanel();
    }
  }

  async function loadWorkspaceDirectory(rootPath: string, directoryPath: string): Promise<void> {
    if (filesState.loadingDirectories.has(directoryPath)) {
      return;
    }

    filesState.loadingDirectories.add(directoryPath);
    renderFilesPanel();

    try {
      const result = await callPocodexIpc("workspace-files/list-directory", {
        root: rootPath,
        path: directoryPath,
      });
      const payload = getWorkspaceFileDirectoryResult(result);
      if (!payload) {
        throw new Error("Workspace directory response was invalid.");
      }
      filesState.directoryEntries.set(payload.path, payload.entries);
      if (payload.path === rootPath) {
        filesState.status = `Loaded ${payload.entries.length} explorer entries.`;
      }
    } catch (error) {
      if (directoryPath === rootPath) {
        filesState.status = "Failed to load explorer.";
      }
      showNotice(error instanceof Error ? error.message : "Failed to load workspace directory.");
    } finally {
      filesState.loadingDirectories.delete(directoryPath);
      renderFilesPanel();
    }
  }

  async function handleWorkspaceDirectoryToggle(entry: WorkspaceFileEntry): Promise<void> {
    if (!filesState.selectedRoot) {
      return;
    }

    if (filesState.expandedDirectories.has(entry.path)) {
      filesState.expandedDirectories.delete(entry.path);
      renderFilesPanel();
      return;
    }

    filesState.expandedDirectories.add(entry.path);
    renderFilesPanel();
    if (!filesState.directoryEntries.has(entry.path)) {
      await loadWorkspaceDirectory(filesState.selectedRoot, entry.path);
    }
  }

  async function openWorkspaceFile(path: string): Promise<void> {
    filesState.selectedFilePath = path;
    filesState.previewPath = path;
    resetWorkspacePreviewState({ keepPath: true });
    filesState.previewLoading = true;
    filesState.status = "Loading file preview...";
    renderFilesPanel();

    try {
      const result = await callPocodexIpc("workspace-files/read", { path });
      const preview = getWorkspaceFileReadResult(result);
      if (!preview) {
        throw new Error("Workspace file preview response was invalid.");
      }

      filesState.previewPath = preview.path;
      filesState.previewRelativePath = preview.relativePath;
      filesState.previewKind = preview.kind;
      filesState.previewMimeType = preview.mimeType;
      filesState.previewSizeBytes = preview.size;

      if (preview.kind === "text") {
        filesState.previewContents = preview.contents;
        filesState.status = "File loaded into preview.";
        void highlightWorkspacePreview(preview.contents, preview.relativePath);
      } else if (preview.kind === "image" || preview.kind === "pdf") {
        const objectUrl = createWorkspacePreviewObjectUrl(preview.contentsBase64, preview.mimeType);
        if (!objectUrl) {
          throw new Error("Failed to create file preview.");
        }

        filesState.previewObjectUrl = objectUrl;
        filesState.status =
          preview.kind === "image" ? "Image loaded into preview." : "PDF loaded into preview.";
      } else {
        filesState.status = "Preview unavailable for this file type.";
      }
    } catch (error) {
      resetWorkspacePreviewState({ keepPath: true });
      filesState.status = "Preview unavailable. Download is still available.";
      showNotice(error instanceof Error ? error.message : "Failed to preview workspace file.");
    } finally {
      filesState.previewLoading = false;
      renderFilesPanel();
    }
  }

  async function focusWorkspaceRoot(nextRoot: string): Promise<void> {
    filesState.selectedRoot = nextRoot;
    filesState.selectedFilePath = null;
    resetWorkspacePreviewState();
    filesState.status = "Loading explorer...";
    filesState.expandedDirectories.clear();
    filesState.expandedDirectories.add(nextRoot);
    filesState.directoryEntries.clear();
    filesState.searchResults = [];
    await loadWorkspaceDirectory(nextRoot, nextRoot);
    if (filesState.searchQuery.trim()) {
      scheduleWorkspaceFileSearch();
    }
  }

  async function revealWorkspaceFile(path: string): Promise<void> {
    const requestedPath = path.trim();
    if (!requestedPath) {
      throw new Error("File path is required.");
    }

    await toggleFilesPanel(true);

    const matchingRoot = findWorkspaceRootForPath(requestedPath);
    if (matchingRoot && filesState.selectedRoot !== matchingRoot.path) {
      await focusWorkspaceRoot(matchingRoot.path);
    } else if (matchingRoot && !filesState.directoryEntries.has(matchingRoot.path)) {
      await loadWorkspaceDirectory(matchingRoot.path, matchingRoot.path);
    }

    await openWorkspaceFile(requestedPath);
  }

  function findWorkspaceRootForPath(path: string): WorkspaceFileRoot | null {
    return filesState.roots.find((root) => isBrowserPathInsideRoot(root.path, path)) ?? null;
  }

  function isBrowserPathInsideRoot(root: string, targetPath: string): boolean {
    const normalizedRoot = normalizeBrowserPath(root);
    const normalizedTarget = normalizeBrowserPath(targetPath);
    if (normalizedRoot === "/") {
      return normalizedTarget.startsWith("/");
    }
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
  }

  function normalizeBrowserPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.length <= 1) {
      return normalized;
    }

    if (/^[A-Za-z]:\/$/.test(normalized)) {
      return normalized;
    }

    return normalized.replace(/\/+$/, "");
  }

  function updateWorkspaceFileSearchQuery(query: string): void {
    filesState.searchQuery = query;
    if (!query.trim()) {
      if (filesSearchTimeoutId !== null) {
        window.clearTimeout(filesSearchTimeoutId);
        filesSearchTimeoutId = null;
      }
      filesSearchRevision += 1;
      filesState.searchLoading = false;
      filesState.searchResults = [];
      renderFilesPanel();
      restoreWorkspaceFileSearchFocus(query);
      return;
    }

    filesState.searchLoading = true;
    renderFilesPanel();
    restoreWorkspaceFileSearchFocus(query);
    scheduleWorkspaceFileSearch();
  }

  function scheduleWorkspaceFileSearch(delayMs = 160): void {
    if (filesSearchTimeoutId !== null) {
      window.clearTimeout(filesSearchTimeoutId);
    }

    const revision = ++filesSearchRevision;
    filesSearchTimeoutId = window.setTimeout(() => {
      filesSearchTimeoutId = null;
      void performWorkspaceFileSearch(revision, filesState.searchQuery);
    }, delayMs);
  }

  async function performWorkspaceFileSearch(revision: number, query: string): Promise<void> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || !filesState.selectedRoot) {
      if (filesSearchRevision === revision) {
        filesState.searchLoading = false;
        filesState.searchResults = [];
        renderFilesPanel();
      }
      return;
    }

    try {
      const result = await callPocodexIpc("workspace-files/search", {
        query: trimmedQuery,
        root: filesState.selectedRoot,
      });
      if (filesSearchRevision !== revision) {
        return;
      }

      filesState.searchResults = getWorkspaceFileSearchResults(result);
      filesState.searchLoading = false;
      renderFilesPanel();
    } catch (error) {
      if (filesSearchRevision !== revision) {
        return;
      }

      filesState.searchLoading = false;
      filesState.searchResults = [];
      renderFilesPanel();
      showNotice(error instanceof Error ? error.message : "Failed to search workspace files.");
    }
  }

  function getSelectedWorkspaceRoot(): WorkspaceFileRoot | null {
    return filesState.roots.find((root) => root.path === filesState.selectedRoot) ?? null;
  }

  function getDefaultFilesDrawerWidthPx(): number {
    return Math.round(
      Math.min(
        FILES_DRAWER_DEFAULT_MAX_WIDTH_PX,
        window.innerWidth * FILES_DRAWER_DEFAULT_VIEWPORT_RATIO,
      ),
    );
  }

  function getMinFilesDrawerWidthPx(): number {
    return Math.max(360, getDefaultFilesDrawerWidthPx());
  }

  function getMaxFilesDrawerWidthPx(): number {
    return Math.max(
      getMinFilesDrawerWidthPx(),
      Math.round(
        Math.min(
          window.innerWidth - FILES_DRAWER_VIEWPORT_MARGIN_PX,
          window.innerWidth * FILES_DRAWER_MAX_VIEWPORT_RATIO,
        ),
      ),
    );
  }

  function clampFilesDrawerWidth(width: number): number {
    return Math.min(
      getMaxFilesDrawerWidthPx(),
      Math.max(getMinFilesDrawerWidthPx(), Math.round(width)),
    );
  }

  function shouldUseResponsiveFilesDrawerWidth(): boolean {
    return window.innerWidth <= 640;
  }

  function getFilesDrawerWidthPx(): number {
    if (shouldUseResponsiveFilesDrawerWidth()) {
      return window.innerWidth;
    }

    if (typeof filesState.drawerWidthPx === "number" && Number.isFinite(filesState.drawerWidthPx)) {
      return clampFilesDrawerWidth(filesState.drawerWidthPx);
    }

    const defaultWidth = clampFilesDrawerWidth(getDefaultFilesDrawerWidthPx());
    filesState.drawerWidthPx = defaultWidth;
    return defaultWidth;
  }

  function getFilesDrawerContentWidthPx(drawerWidth: number): number {
    return Math.max(420, drawerWidth - FILES_DRAWER_HORIZONTAL_PADDING_PX);
  }

  function getMinFilesExplorerWidthPx(): number {
    return FILES_EXPLORER_MIN_WIDTH_PX;
  }

  function getMaxFilesExplorerWidthPx(drawerWidth: number): number {
    return Math.max(
      getMinFilesExplorerWidthPx(),
      getFilesDrawerContentWidthPx(drawerWidth) -
        FILES_PREVIEW_MIN_WIDTH_PX -
        FILES_EXPLORER_RESIZE_HANDLE_WIDTH_PX,
    );
  }

  function clampFilesExplorerWidth(width: number, drawerWidth: number): number {
    return Math.min(
      getMaxFilesExplorerWidthPx(drawerWidth),
      Math.max(getMinFilesExplorerWidthPx(), Math.round(width)),
    );
  }

  function getDefaultFilesExplorerWidthPx(drawerWidth: number): number {
    const contentWidth = getFilesDrawerContentWidthPx(drawerWidth);
    return clampFilesExplorerWidth(Math.round(contentWidth * 0.22), drawerWidth);
  }

  function getFilesExplorerWidthPx(drawerWidth: number): number {
    if (shouldUseResponsiveFilesDrawerWidth()) {
      return drawerWidth;
    }

    if (
      typeof filesState.explorerWidthPx === "number" &&
      Number.isFinite(filesState.explorerWidthPx)
    ) {
      return clampFilesExplorerWidth(filesState.explorerWidthPx, drawerWidth);
    }

    const defaultWidth = getDefaultFilesExplorerWidthPx(drawerWidth);
    filesState.explorerWidthPx = defaultWidth;
    return defaultWidth;
  }

  function applyFilesDrawerWidth(drawer: HTMLElement): void {
    if (shouldUseResponsiveFilesDrawerWidth()) {
      drawer.style.removeProperty("width");
      drawer.style.removeProperty("max-width");
      return;
    }

    const width = getFilesDrawerWidthPx();
    drawer.style.width = `${width}px`;
    drawer.style.maxWidth = `${getMaxFilesDrawerWidthPx()}px`;
  }

  function applyFilesExplorerWidth(body: HTMLElement, drawer: HTMLElement): void {
    if (shouldUseResponsiveFilesDrawerWidth()) {
      body.style.removeProperty("--pocodex-files-explorer-width");
      return;
    }

    const drawerWidth = Math.round(drawer.getBoundingClientRect().width || getFilesDrawerWidthPx());
    const width = getFilesExplorerWidthPx(drawerWidth);
    body.style.setProperty("--pocodex-files-explorer-width", `${width}px`);
    filesState.explorerWidthPx = width;
  }

  function installFilesDrawerResizeHandle(handle: HTMLElement, drawer: HTMLElement): void {
    if (shouldUseResponsiveFilesDrawerWidth()) {
      return;
    }

    handle.addEventListener("pointerdown", (event) => {
      if (!(event instanceof PointerEvent) || event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const handleTarget = event.currentTarget;
      if (!(handleTarget instanceof HTMLElement)) {
        return;
      }

      const setDrawerWidth = (nextWidth: number) => {
        const width = clampFilesDrawerWidth(nextWidth);
        filesState.drawerWidthPx = width;
        drawer.style.width = `${width}px`;
        const body = drawer.querySelector<HTMLElement>('[data-pocodex-files-body="true"]');
        if (body) {
          const explorerWidth = clampFilesExplorerWidth(getFilesExplorerWidthPx(width), width);
          filesState.explorerWidthPx = explorerWidth;
          body.style.setProperty("--pocodex-files-explorer-width", `${explorerWidth}px`);
        }
      };

      handleTarget.setPointerCapture(event.pointerId);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setDrawerWidth(window.innerWidth - moveEvent.clientX);
      };

      const stopResizing = () => {
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (handleTarget.hasPointerCapture(event.pointerId)) {
          handleTarget.releasePointerCapture(event.pointerId);
        }
        setDrawerWidth(window.innerWidth - upEvent.clientX);
        stopResizing();
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("pointercancel", handlePointerUp, { once: true });
    });
  }

  function installFilesExplorerResizeHandle(
    handle: HTMLElement,
    body: HTMLElement,
    drawer: HTMLElement,
  ): void {
    if (shouldUseResponsiveFilesDrawerWidth()) {
      return;
    }

    handle.addEventListener("pointerdown", (event) => {
      if (!(event instanceof PointerEvent) || event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const handleTarget = event.currentTarget;
      if (!(handleTarget instanceof HTMLElement)) {
        return;
      }

      const setExplorerWidth = (clientX: number) => {
        const bodyRect = body.getBoundingClientRect();
        const drawerWidth = Math.round(drawer.getBoundingClientRect().width || getFilesDrawerWidthPx());
        const nextWidth = clientX - bodyRect.left - FILES_EXPLORER_RESIZE_HANDLE_WIDTH_PX / 2;
        const width = clampFilesExplorerWidth(nextWidth, drawerWidth);
        filesState.explorerWidthPx = width;
        body.style.setProperty("--pocodex-files-explorer-width", `${width}px`);
      };

      handleTarget.setPointerCapture(event.pointerId);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setExplorerWidth(moveEvent.clientX);
      };

      const stopResizing = () => {
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (handleTarget.hasPointerCapture(event.pointerId)) {
          handleTarget.releasePointerCapture(event.pointerId);
        }
        setExplorerWidth(upEvent.clientX);
        stopResizing();
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("pointercancel", handlePointerUp, { once: true });
    });
  }

  function getExplorerSummary(): string {
    if (!filesState.selectedRoot) {
      return "No workspace";
    }

    const rootEntries = filesState.directoryEntries.get(filesState.selectedRoot) ?? [];
    const count = rootEntries.length;
    return count === 1 ? "1 entry" : `${count} entries`;
  }

  function getWorkspacePreviewFileName(): string {
    const activePath = getActiveWorkspacePreviewPath();
    return (
      filesState.previewRelativePath.split("/").filter(Boolean).at(-1) ||
      activePath?.split("/").filter(Boolean).at(-1) ||
      "Choose a file"
    );
  }

  function getActiveWorkspacePreviewPath(): string | null {
    return filesState.previewPath || filesState.selectedFilePath || null;
  }

  function getWorkspacePreviewLanguageLabel(path: string): string {
    const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
    return getWorkspacePreviewLanguageLabelForExtension(extension);
  }

  function getWorkspacePreviewLanguageLabelForExtension(extension: string): string {
    switch (extension) {
      case "ts":
      case "tsx":
        return "TypeScript";
      case "js":
      case "jsx":
      case "mjs":
      case "cjs":
        return "JavaScript";
      case "json":
        return "JSON";
      case "md":
      case "mdx":
        return "Markdown";
      case "css":
      case "scss":
      case "sass":
      case "less":
        return "Stylesheet";
      case "html":
      case "htm":
        return "HTML";
      case "vue":
        return "Vue";
      case "py":
        return "Python";
      case "rs":
        return "Rust";
      case "go":
        return "Go";
      case "java":
        return "Java";
      case "yml":
      case "yaml":
        return "YAML";
      case "sh":
      case "bash":
      case "zsh":
        return "Shell";
      default:
        return extension ? extension.toUpperCase() : "Text";
    }
  }

  function getWorkspacePreviewHighlightLanguage(path: string): string | undefined {
    const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
    switch (extension) {
      case "ts":
      case "tsx":
        return "typescript";
      case "js":
      case "jsx":
      case "mjs":
      case "cjs":
        return "javascript";
      case "json":
      case "jsonc":
      case "json5":
        return "json";
      case "md":
      case "mdx":
        return "markdown";
      case "css":
        return "css";
      case "scss":
      case "sass":
        return "scss";
      case "less":
        return "less";
      case "html":
      case "htm":
      case "svg":
      case "vue":
      case "xml":
        return "html";
      case "py":
        return "python";
      case "rs":
        return "rust";
      case "go":
        return "go";
      case "java":
        return "java";
      case "yml":
      case "yaml":
        return "yaml";
      case "sh":
      case "bash":
      case "zsh":
        return "shell";
      case "c":
      case "h":
        return "c";
      case "cc":
      case "cpp":
      case "cxx":
      case "hh":
      case "hpp":
      case "hxx":
        return "cpp";
      case "php":
        return "php";
      case "sql":
        return "sql";
      case "rb":
        return "ruby";
      case "kt":
      case "kts":
        return "kotlin";
      case "lua":
        return "lua";
      case "ini":
      case "toml":
        return "ini";
      case "diff":
      case "patch":
        return "diff";
      default:
        return undefined;
    }
  }

  function getWorkspacePreviewLanguageLabelForHighlightLanguage(language: string): string {
    switch (language) {
      case "typescript":
        return "TypeScript";
      case "javascript":
        return "JavaScript";
      case "json":
        return "JSON";
      case "markdown":
        return "Markdown";
      case "css":
      case "scss":
      case "less":
        return "Stylesheet";
      case "html":
      case "xml":
        return "HTML";
      case "python":
        return "Python";
      case "rust":
        return "Rust";
      case "go":
        return "Go";
      case "java":
        return "Java";
      case "yaml":
        return "YAML";
      case "shell":
      case "bash":
        return "Shell";
      case "c":
        return "C";
      case "cpp":
        return "C++";
      case "php":
        return "PHP";
      case "sql":
        return "SQL";
      case "ruby":
        return "Ruby";
      case "kotlin":
        return "Kotlin";
      case "lua":
        return "Lua";
      case "ini":
        return "Config";
      case "diff":
        return "Diff";
      default:
        return language ? language.toUpperCase() : "Text";
    }
  }

  function getWorkspacePreviewLineCount(contents: string): number {
    if (!contents) {
      return 1;
    }
    return contents.split("\n").length;
  }

  function getWorkspacePreviewDisplayLanguageLabel(): string {
    if (filesState.previewHighlightedLanguage) {
      return getWorkspacePreviewLanguageLabelForHighlightLanguage(
        filesState.previewHighlightedLanguage,
      );
    }

    return getWorkspacePreviewLanguageLabel(filesState.previewRelativePath);
  }

  function createWorkspacePreviewObjectUrl(
    contentsBase64: string,
    mimeType: string,
  ): string | null {
    if (
      typeof Blob === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function" ||
      typeof atob !== "function"
    ) {
      return null;
    }

    try {
      const binary = atob(contentsBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    } catch {
      return null;
    }
  }

  function formatWorkspacePreviewFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }

    if (bytes < 1_024) {
      return `${bytes} B`;
    }

    if (bytes < 1_048_576) {
      return `${(bytes / 1_024).toFixed(1)} KB`;
    }

    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }

  function getWorkspacePreviewMetaDescription(): string {
    const activePath = getActiveWorkspacePreviewPath();
    if (!activePath) {
      return "Text preview";
    }

    if (filesState.previewKind === "text") {
      return `${getWorkspacePreviewDisplayLanguageLabel()} · ${getWorkspacePreviewLineCount(
        filesState.previewContents,
      )} lines${filesState.previewHighlighting ? " · Highlighting..." : ""}`;
    }

    if (filesState.previewKind === "image") {
      return `Image · ${formatWorkspacePreviewFileSize(filesState.previewSizeBytes)}`;
    }

    if (filesState.previewKind === "pdf") {
      return `PDF · ${formatWorkspacePreviewFileSize(filesState.previewSizeBytes)}`;
    }

    if (filesState.previewKind === "binary") {
      return `${filesState.previewMimeType || "Binary"} · ${formatWorkspacePreviewFileSize(
        filesState.previewSizeBytes,
      )}`;
    }

    return filesState.previewLoading ? "Loading preview..." : "Preview unavailable";
  }

  async function copyWorkspacePreviewPath(): Promise<void> {
    const activePath = getActiveWorkspacePreviewPath();
    if (!activePath) {
      return;
    }

    const copied = await copyTextToClipboard(activePath);
    showNotice(copied ? "Workspace path copied." : "Clipboard is not available in this browser.");
  }

  async function downloadWorkspacePreview(): Promise<void> {
    const activePath = getActiveWorkspacePreviewPath();
    if (!activePath) {
      return;
    }

    const fileName = getWorkspacePreviewFileName();

    try {
      const link = document.createElement("a");
      link.href = buildWorkspacePreviewDownloadUrl(activePath);
      link.download = fileName;
      link.rel = "noopener";
      link.style.display = "none";
      document.body?.appendChild(link);
      link.click();
      link.remove();
      showNotice(`Downloading ${fileName}...`);
    } catch {
      showNotice("Failed to prepare file download.");
    }
  }

  function buildWorkspacePreviewDownloadUrl(path: string): string {
    const url = new URL("/workspace-file-download", window.location.href);
    url.searchParams.set("path", path);
    const token = getStoredToken();
    if (token) {
      url.searchParams.set("token", token);
    }
    return url.toString();
  }

  async function copyTextToClipboard(value: string): Promise<boolean> {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fall through to legacy copy handling.
      }
    }

    if (!document.body || typeof document.execCommand !== "function") {
      return false;
    }

    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.setAttribute("readonly", "true");
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    textArea.style.pointerEvents = "none";
    document.body.appendChild(textArea);
    textArea.select();

    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textArea.remove();
    }
  }

  function collapseWorkspaceDirectories(): void {
    if (!filesState.selectedRoot) {
      return;
    }

    filesState.expandedDirectories.clear();
    filesState.expandedDirectories.add(filesState.selectedRoot);
    renderFilesPanel();
  }

  function restoreWorkspaceFileSearchFocus(query: string): void {
    window.setTimeout(() => {
      const input = document.querySelector('[data-pocodex-files-search-input="true"]');
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      input.focus();
      input.setSelectionRange(query.length, query.length);
    }, 0);
  }

  function renderWorkspaceFileSearchResults(): HTMLElement {
    const resultList = document.createElement("div");
    resultList.dataset.pocodexFilesSearchResults = "true";

    if (filesState.searchLoading) {
      const loading = document.createElement("p");
      loading.dataset.pocodexFilesEmptyState = "true";
      loading.textContent = "Searching files...";
      resultList.appendChild(loading);
      return resultList;
    }

    if (filesState.searchResults.length === 0) {
      const emptyState = document.createElement("p");
      emptyState.dataset.pocodexFilesEmptyState = "true";
      emptyState.textContent = `No files matched "${filesState.searchQuery.trim()}".`;
      resultList.appendChild(emptyState);
      return resultList;
    }

    filesState.searchResults.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.pocodexFilesSearchResult = "true";
      if (entry.path === filesState.selectedFilePath) {
        button.dataset.selected = "true";
      }
      button.addEventListener("click", () => {
        void openWorkspaceFile(entry.path);
      });

      const label = document.createElement("strong");
      label.textContent =
        entry.relativePath.split("/").filter(Boolean).at(-1) || entry.relativePath;

      const detail = document.createElement("span");
      detail.textContent = entry.relativePath;

      button.append(label, detail);
      resultList.appendChild(button);
    });

    return resultList;
  }

  async function loadWorkspacePreviewHighlighter(): Promise<HighlightCodeModule | null> {
    if (!workspacePreviewHighlighterPromise) {
      if (!config.highlightModuleHref) {
        workspacePreviewHighlighterPromise = Promise.resolve(null);
        return workspacePreviewHighlighterPromise;
      }

      workspacePreviewHighlighterPromise = import(config.highlightModuleHref)
        .then((module) =>
          module &&
          typeof module === "object" &&
          "highlightCode" in module &&
          typeof module.highlightCode === "function"
            ? (module as HighlightCodeModule)
            : null,
        )
        .catch(() => null);
    }

    return workspacePreviewHighlighterPromise;
  }

  async function highlightWorkspacePreview(contents: string, relativePath: string): Promise<void> {
    const revision = ++filesState.previewHighlightRevision;
    filesState.previewHighlightedHtml = "";
    filesState.previewHighlightedLanguage = "";
    const preferredLanguage = getWorkspacePreviewHighlightLanguage(relativePath);

    if (!contents || contents.length > WORKSPACE_PREVIEW_HIGHLIGHT_MAX_CHARACTERS) {
      filesState.previewHighlighting = false;
      renderFilesPanel();
      return;
    }

    if (!preferredLanguage && contents.length > WORKSPACE_PREVIEW_AUTO_HIGHLIGHT_MAX_CHARACTERS) {
      filesState.previewHighlighting = false;
      renderFilesPanel();
      return;
    }

    const cacheKey = getWorkspacePreviewHighlightCacheKey(contents, relativePath, preferredLanguage);
    const cachedResult = workspacePreviewHighlightCache.get(cacheKey);
    if (cachedResult) {
      workspacePreviewHighlightCache.delete(cacheKey);
      workspacePreviewHighlightCache.set(cacheKey, cachedResult);
      filesState.previewHighlightedHtml = cachedResult.html;
      filesState.previewHighlightedLanguage = cachedResult.language;
      filesState.previewHighlighting = false;
      renderFilesPanel();
      return;
    }

    filesState.previewHighlighting = true;
    renderFilesPanel();

    const highlighter = await loadWorkspacePreviewHighlighter();
    if (!highlighter || filesState.previewHighlightRevision !== revision) {
      if (filesState.previewHighlightRevision === revision) {
        filesState.previewHighlighting = false;
        renderFilesPanel();
      }
      return;
    }

    try {
      const result = preferredLanguage
        ? highlighter.highlightCode(contents, preferredLanguage)
        : highlighter.highlightCode(contents);

      if (filesState.previewHighlightRevision !== revision) {
        return;
      }

      filesState.previewHighlightedHtml = typeof result.html === "string" ? result.html : "";
      filesState.previewHighlightedLanguage =
        typeof result.language === "string" && result.language.length > 0
          ? result.language
          : (preferredLanguage ?? "");
      rememberWorkspacePreviewHighlightResult(
        cacheKey,
        filesState.previewHighlightedHtml,
        filesState.previewHighlightedLanguage,
      );
    } catch {
      if (preferredLanguage) {
        try {
          const fallback = highlighter.highlightCode(contents);
          if (filesState.previewHighlightRevision !== revision) {
            return;
          }
          filesState.previewHighlightedHtml =
            typeof fallback.html === "string" ? fallback.html : "";
          filesState.previewHighlightedLanguage =
            typeof fallback.language === "string" && fallback.language.length > 0
              ? fallback.language
              : "";
          rememberWorkspacePreviewHighlightResult(
            cacheKey,
            filesState.previewHighlightedHtml,
            filesState.previewHighlightedLanguage,
          );
        } catch {
          if (filesState.previewHighlightRevision !== revision) {
            return;
          }
          filesState.previewHighlightedHtml = "";
          filesState.previewHighlightedLanguage = "";
        }
      }
    } finally {
      if (filesState.previewHighlightRevision === revision) {
        filesState.previewHighlighting = false;
        renderFilesPanel();
      }
    }
  }

  function getWorkspacePreviewHighlightCacheKey(
    contents: string,
    relativePath: string,
    language?: string,
  ): string {
    return `${relativePath}\u0000${language ?? ""}\u0000${contents.length}\u0000${hashWorkspacePreviewContents(contents)}`;
  }

  function hashWorkspacePreviewContents(contents: string): string {
    let hash = 2166136261;
    for (let index = 0; index < contents.length; index += 1) {
      hash ^= contents.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function rememberWorkspacePreviewHighlightResult(
    cacheKey: string,
    html: string,
    language: string,
  ): void {
    workspacePreviewHighlightCache.set(cacheKey, { html, language });
    while (workspacePreviewHighlightCache.size > WORKSPACE_PREVIEW_HIGHLIGHT_CACHE_LIMIT) {
      const oldestKey = workspacePreviewHighlightCache.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      workspacePreviewHighlightCache.delete(oldestKey);
    }
  }

  function createWorkspacePreviewLineRow(lineNumberValue: number, contentNode?: Node): HTMLElement {
    const row = document.createElement("div");
    row.dataset.pocodexFilesPreviewLine = "true";

    const lineNumber = document.createElement("span");
    lineNumber.dataset.pocodexFilesPreviewLineNumber = "true";
    lineNumber.textContent = String(lineNumberValue);

    const lineContent = document.createElement("span");
    lineContent.dataset.pocodexFilesPreviewLineContent = "true";

    if (contentNode) {
      lineContent.appendChild(contentNode);
    } else {
      lineContent.textContent = " ";
    }

    row.append(lineNumber, lineContent);
    return row;
  }

  function splitWorkspacePreviewHighlightedLines(highlightedHtml: string): DocumentFragment[] {
    const template = document.createElement("template");
    template.innerHTML = highlightedHtml;

    const lines: DocumentFragment[] = [];
    const originalElementStack: Element[] = [];
    let currentLine = document.createDocumentFragment();
    let currentCloneStack: Element[] = [];

    const currentParent = (): Node => currentCloneStack.at(-1) ?? currentLine;

    const startNewLine = (): void => {
      currentLine = document.createDocumentFragment();
      currentCloneStack = [];
      let parent: Node = currentLine;

      originalElementStack.forEach((element) => {
        const clone = element.cloneNode(false);
        if (!(clone instanceof Element)) {
          return;
        }
        parent.appendChild(clone);
        currentCloneStack.push(clone);
        parent = clone;
      });

      lines.push(currentLine);
    };

    const visitNode = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parts = (node.textContent ?? "").split("\n");
        parts.forEach((part, index) => {
          if (index > 0) {
            startNewLine();
          }
          if (part.length > 0) {
            currentParent().appendChild(document.createTextNode(part));
          }
        });
        return;
      }

      if (!(node instanceof Element)) {
        return;
      }

      const clone = node.cloneNode(false);
      if (!(clone instanceof Element)) {
        return;
      }

      currentParent().appendChild(clone);
      originalElementStack.push(node);
      currentCloneStack.push(clone);
      Array.from(node.childNodes).forEach(visitNode);
      currentCloneStack.pop();
      originalElementStack.pop();
    };

    startNewLine();
    Array.from(template.content.childNodes).forEach(visitNode);

    return lines.length > 0 ? lines : [document.createDocumentFragment()];
  }

  function renderWorkspacePreviewContent(contents: string): HTMLElement {
    const editor = document.createElement("div");
    editor.dataset.pocodexFilesPreviewEditor = "true";
    const totalLines = getWorkspacePreviewLineCount(contents);
    editor.style.setProperty(
      "--pocodex-files-line-number-width",
      `${String(totalLines).length + 1}ch`,
    );

    if (filesState.previewHighlightedHtml) {
      const languageClass = filesState.previewHighlightedLanguage
        ? `language-${filesState.previewHighlightedLanguage}`
        : "";
      const highlightedLines = splitWorkspacePreviewHighlightedLines(
        filesState.previewHighlightedHtml,
      );

      highlightedLines.forEach((fragment, index) => {
        const code = document.createElement("code");
        code.className = ["hljs", languageClass].filter(Boolean).join(" ");
        if (fragment.childNodes.length === 0) {
          code.textContent = " ";
        } else {
          code.appendChild(fragment);
        }
        editor.appendChild(createWorkspacePreviewLineRow(index + 1, code));
      });

      return editor;
    }

    const lines = contents.length > 0 ? contents.split("\n") : [""];
    lines.forEach((line, index) => {
      const lineContent = document.createElement("code");
      lineContent.className = "hljs";
      lineContent.textContent = line.length > 0 ? line : " ";
      editor.appendChild(createWorkspacePreviewLineRow(index + 1, lineContent));
    });

    return editor;
  }

  function renderWorkspacePreviewImage(): HTMLElement {
    const stage = document.createElement("div");
    stage.dataset.pocodexFilesPreviewMedia = "true";
    stage.dataset.kind = "image";

    if (!filesState.previewObjectUrl) {
      const emptyState = document.createElement("p");
      emptyState.dataset.pocodexFilesEmptyState = "true";
      emptyState.textContent = "Image preview is unavailable.";
      stage.appendChild(emptyState);
      return stage;
    }

    const image = document.createElement("img");
    image.dataset.pocodexFilesPreviewImage = "true";
    image.alt = getWorkspacePreviewFileName();
    image.src = filesState.previewObjectUrl;
    stage.appendChild(image);
    return stage;
  }

  function renderWorkspacePreviewPdf(): HTMLElement {
    const stage = document.createElement("div");
    stage.dataset.pocodexFilesPreviewMedia = "true";
    stage.dataset.kind = "pdf";

    if (!filesState.previewObjectUrl) {
      const emptyState = document.createElement("p");
      emptyState.dataset.pocodexFilesEmptyState = "true";
      emptyState.textContent = "PDF preview is unavailable.";
      stage.appendChild(emptyState);
      return stage;
    }

    const frame = document.createElement("iframe");
    frame.dataset.pocodexFilesPreviewPdf = "true";
    frame.title = getWorkspacePreviewFileName();
    frame.src = filesState.previewObjectUrl;
    stage.appendChild(frame);
    return stage;
  }

  function renderFilesPanel(): void {
    ensureHostAttached(filesHost);
    filesHost.hidden = !filesState.open;
    filesHost.replaceChildren();

    if (!filesState.open) {
      return;
    }

    const backdrop = document.createElement("div");
    backdrop.dataset.pocodexFilesBackdrop = "true";
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) {
        return;
      }
      void toggleFilesPanel(false);
    });

    const drawer = document.createElement("aside");
    drawer.dataset.pocodexFilesDrawer = "true";
    applyFilesDrawerWidth(drawer);

    const resizeHandle = document.createElement("button");
    resizeHandle.type = "button";
    resizeHandle.dataset.pocodexFilesResizeHandle = "true";
    resizeHandle.setAttribute("aria-label", "Resize files panel");
    installFilesDrawerResizeHandle(resizeHandle, drawer);

    const header = document.createElement("div");
    header.dataset.pocodexFilesHeader = "true";

    const titleGroup = document.createElement("div");
    titleGroup.dataset.pocodexFilesHeaderCopy = "true";

    const title = document.createElement("h2");
    title.textContent = "Files";

    const subtitle = document.createElement("p");
    subtitle.textContent = filesState.status;

    titleGroup.append(title, subtitle);

    const headerActions = document.createElement("div");
    headerActions.dataset.pocodexFilesHeaderActions = "true";

    const rootSelect = document.createElement("select");
    rootSelect.dataset.pocodexFilesRootSelect = "true";
    rootSelect.disabled = filesState.roots.length <= 1 || filesState.isRefreshing;
    filesState.roots.forEach((root) => {
      const option = document.createElement("option");
      option.value = root.path;
      option.textContent = root.label;
      option.selected = root.path === filesState.selectedRoot;
      rootSelect.appendChild(option);
    });
    rootSelect.addEventListener("change", () => {
      void focusWorkspaceRoot(rootSelect.value);
    });

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.textContent = filesState.isRefreshing ? "Refreshing..." : "Refresh";
    refreshButton.disabled = filesState.isRefreshing;
    refreshButton.addEventListener("click", () => {
      void refreshWorkspaceFileRoots();
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.dataset.variant = "primary";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => {
      void toggleFilesPanel(false);
    });

    headerActions.append(rootSelect, refreshButton, closeButton);
    header.append(titleGroup, headerActions);

    const body = document.createElement("div");
    body.dataset.pocodexFilesBody = "true";
    applyFilesExplorerWidth(body, drawer);

    const explorerPanel = document.createElement("section");
    explorerPanel.dataset.pocodexFilesExplorerPanel = "true";

    const explorerHead = document.createElement("div");
    explorerHead.dataset.pocodexFilesExplorerHead = "true";

    const explorerHeadCopy = document.createElement("div");
    explorerHeadCopy.dataset.pocodexFilesExplorerHeadCopy = "true";

    const explorerHeading = document.createElement("div");
    explorerHeading.dataset.pocodexFilesHeading = "true";
    explorerHeading.textContent = "Explorer";

    const explorerRoot = document.createElement("div");
    explorerRoot.dataset.pocodexFilesRootLabel = "true";
    explorerRoot.textContent = getSelectedWorkspaceRoot()?.label ?? "No workspace";

    explorerHeadCopy.append(explorerHeading, explorerRoot);

    const explorerSummary = document.createElement("span");
    explorerSummary.dataset.pocodexFilesExplorerSummary = "true";
    explorerSummary.textContent = filesState.searchQuery.trim()
      ? `${filesState.searchResults.length} matches`
      : getExplorerSummary();

    const explorerActions = document.createElement("div");
    explorerActions.dataset.pocodexFilesSectionActions = "true";

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.textContent = "Collapse all";
    collapseButton.disabled = !filesState.selectedRoot;
    collapseButton.addEventListener("click", () => {
      collapseWorkspaceDirectories();
    });

    explorerActions.append(explorerSummary, collapseButton);
    explorerHead.append(explorerHeadCopy, explorerActions);

    const explorerRootPath = document.createElement("div");
    explorerRootPath.dataset.pocodexFilesRootPath = "true";
    explorerRootPath.textContent = filesState.selectedRoot
      ? formatDesktopImportPath(filesState.selectedRoot)
      : "No workspace root selected.";

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    searchInput.placeholder = "Search files in this workspace";
    searchInput.value = filesState.searchQuery;
    searchInput.dataset.pocodexFilesSearchInput = "true";
    searchInput.addEventListener("input", () => {
      updateWorkspaceFileSearchQuery(searchInput.value);
    });

    const tree = document.createElement("div");
    tree.dataset.pocodexFilesTree = "true";

    if (filesState.roots.length === 0) {
      const emptyState = document.createElement("p");
      emptyState.dataset.pocodexFilesEmptyState = "true";
      emptyState.textContent = "No workspace roots are available for file browsing.";
      tree.appendChild(emptyState);
    } else if (!filesState.selectedRoot) {
      const emptyState = document.createElement("p");
      emptyState.dataset.pocodexFilesEmptyState = "true";
      emptyState.textContent = "Select a workspace root to start browsing files.";
      tree.appendChild(emptyState);
    } else if (filesState.searchQuery.trim()) {
      tree.appendChild(renderWorkspaceFileSearchResults());
    } else {
      tree.appendChild(renderWorkspaceDirectoryTree(filesState.selectedRoot, 0));
    }

    explorerPanel.append(explorerHead, explorerRootPath, searchInput, tree);

    const explorerResizeHandle = document.createElement("button");
    explorerResizeHandle.type = "button";
    explorerResizeHandle.dataset.pocodexFilesInnerResizeHandle = "true";
    explorerResizeHandle.setAttribute("aria-label", "Resize explorer panel");
    installFilesExplorerResizeHandle(explorerResizeHandle, body, drawer);

    const preview = document.createElement("section");
    preview.dataset.pocodexFilesPreview = "true";

    const previewHeader = document.createElement("div");
    previewHeader.dataset.pocodexFilesPreviewHeader = "true";

    const previewTitleGroup = document.createElement("div");
    previewTitleGroup.dataset.pocodexFilesPreviewTitleGroup = "true";

    const previewHeading = document.createElement("div");
    previewHeading.dataset.pocodexFilesHeading = "true";
    previewHeading.textContent = "Preview";

    const previewTitle = document.createElement("code");
    previewTitle.dataset.pocodexFilesPreviewTitlePath = "true";
    previewTitle.textContent = getActiveWorkspacePreviewPath()
      ? formatDesktopImportPath(getActiveWorkspacePreviewPath() as string)
      : "Select a file from the workspace explorer.";

    const previewActions = document.createElement("div");
    previewActions.dataset.pocodexFilesSectionActions = "true";

    const previewMeta = document.createElement("span");
    previewMeta.dataset.pocodexFilesPreviewMeta = "true";
    previewMeta.textContent = getWorkspacePreviewMetaDescription();

    const copyPathButton = document.createElement("button");
    copyPathButton.type = "button";
    copyPathButton.textContent = "Copy path";
    copyPathButton.disabled = !getActiveWorkspacePreviewPath();
    copyPathButton.addEventListener("click", () => {
      void copyWorkspacePreviewPath();
    });

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.textContent = "Download";
    downloadButton.disabled = !getActiveWorkspacePreviewPath();
    downloadButton.addEventListener("click", () => {
      void downloadWorkspacePreview();
    });

    previewActions.append(previewMeta, downloadButton, copyPathButton);
    previewTitleGroup.append(previewHeading, previewTitle);
    previewHeader.append(previewTitleGroup, previewActions);

    const previewBody = document.createElement("div");
    previewBody.dataset.pocodexFilesPreviewBody = "true";

    if (filesState.previewLoading) {
      const loading = document.createElement("p");
      loading.dataset.pocodexFilesEmptyState = "true";
      loading.textContent = "Loading file preview...";
      previewBody.appendChild(loading);
    } else if (getActiveWorkspacePreviewPath()) {
      if (filesState.previewKind === "text") {
        previewBody.appendChild(renderWorkspacePreviewContent(filesState.previewContents));
      } else if (filesState.previewKind === "image") {
        previewBody.appendChild(renderWorkspacePreviewImage());
      } else if (filesState.previewKind === "pdf") {
        previewBody.appendChild(renderWorkspacePreviewPdf());
      } else {
        const emptyState = document.createElement("p");
        emptyState.dataset.pocodexFilesEmptyState = "true";
        emptyState.textContent = "Preview is not available for this file. You can still download it.";
        previewBody.appendChild(emptyState);
      }
    } else {
      const emptyState = document.createElement("p");
      emptyState.dataset.pocodexFilesEmptyState = "true";
      emptyState.textContent = "Choose a file from the sidebar to inspect its contents here.";
      previewBody.appendChild(emptyState);
    }

    preview.append(previewHeader, previewBody);
    body.append(explorerPanel, explorerResizeHandle, preview);
    drawer.append(resizeHandle, header, body);
    backdrop.appendChild(drawer);
    filesHost.appendChild(backdrop);
  }

  function renderWorkspaceDirectoryTree(directoryPath: string, depth: number): HTMLElement {
    const list = document.createElement("ul");
    list.dataset.pocodexFilesTreeList = "true";

    if (
      filesState.loadingDirectories.has(directoryPath) &&
      !filesState.directoryEntries.has(directoryPath)
    ) {
      const item = document.createElement("li");
      item.dataset.pocodexFilesTreeNode = "true";
      const loading = document.createElement("p");
      loading.dataset.pocodexFilesEmptyState = "true";
      loading.textContent = "Loading directory...";
      item.appendChild(loading);
      list.appendChild(item);
      return list;
    }

    const entries = filesState.directoryEntries.get(directoryPath) ?? [];
    if (entries.length === 0) {
      return list;
    }

    entries.forEach((entry) => {
      const item = document.createElement("li");
      item.dataset.pocodexFilesTreeNode = "true";

      const row = document.createElement("button");
      row.type = "button";
      row.dataset.pocodexFilesTreeRow = "true";
      row.dataset.kind = entry.kind;
      row.style.setProperty("--pocodex-depth", String(depth));
      if (entry.path === filesState.selectedFilePath) {
        row.dataset.selected = "true";
      }

      const chevron = document.createElement("span");
      chevron.dataset.pocodexFilesTreeChevron = "true";
      chevron.textContent =
        entry.kind === "directory"
          ? filesState.loadingDirectories.has(entry.path) &&
            !filesState.directoryEntries.has(entry.path)
            ? "⋯"
            : filesState.expandedDirectories.has(entry.path)
              ? "⌄"
              : "›"
          : "";

      const icon = document.createElement("span");
      icon.dataset.pocodexFilesTreeIcon = "true";
      icon.textContent =
        entry.kind === "directory"
          ? filesState.expandedDirectories.has(entry.path)
            ? "📂"
            : "📁"
          : "📄";

      const name = document.createElement("span");
      name.dataset.pocodexFilesTreeName = "true";
      name.textContent = entry.name;

      row.append(chevron, icon, name);
      row.addEventListener("click", () => {
        if (entry.kind === "directory") {
          void handleWorkspaceDirectoryToggle(entry);
          return;
        }
        void openWorkspaceFile(entry.path);
      });
      item.appendChild(row);

      if (
        entry.kind === "directory" &&
        filesState.expandedDirectories.has(entry.path) &&
        filesState.directoryEntries.has(entry.path)
      ) {
        item.appendChild(renderWorkspaceDirectoryTree(entry.path, depth + 1));
      }

      list.appendChild(item);
    });

    return list;
  }

  function getFilesToggleIconSvg(): string {
    return [
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm">',
      '<path d="M3.833 4.667c0-.92.747-1.667 1.667-1.667h3.038c.442 0 .866.176 1.178.488l1.13 1.13c.156.156.367.244.588.244H14.5c.92 0 1.667.747 1.667 1.667v7.971c0 .92-.747 1.667-1.667 1.667h-9c-.92 0-1.667-.747-1.667-1.667V4.667Z" fill="currentColor" fill-opacity=".12"/>',
      '<path d="M5.5 3a2 2 0 0 0-2 2v9.5a2.5 2.5 0 0 0 2.5 2.5h8.5a2 2 0 0 0 2-2V6.53a2 2 0 0 0-2-2h-3.066a.833.833 0 0 1-.589-.244l-1.13-1.13A2.5 2.5 0 0 0 7.948 3H5.5Zm0 1.333h2.448c.31 0 .608.123.826.342l1.13 1.13a2.167 2.167 0 0 0 1.53.634H14.5a.667.667 0 0 1 .667.667V15a.667.667 0 0 1-.667.667H6a1.167 1.167 0 0 1-1.167-1.167V5a.667.667 0 0 1 .667-.667Z" fill="currentColor"/>',
      "</svg>",
    ].join("");
  }

  function maybeInjectSettingsMenuImportItem(menu: Element): void {
    if (!looksLikeAccountMenu(menu)) {
      return;
    }

    if (menu.querySelector('[data-pocodex-import-menu-item="true"]')) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.dataset.pocodexImportMenuItem = "true";
    const label = document.createElement("span");
    label.dataset.pocodexImportMenuLabel = "true";
    label.textContent = "Import from Codex.app";
    button.append(createImportMenuItemIcon(), label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openDesktopImportDialog("manual");
    });

    const separator = document.createElement("div");
    separator.role = "separator";
    separator.dataset.pocodexImportMenuSeparator = "true";

    menu.append(separator, button);
  }

  function createImportMenuItemIcon(): HTMLSpanElement {
    const icon = document.createElement("span");
    icon.dataset.pocodexImportMenuIcon = "true";
    if (config.importIconSvg) {
      icon.innerHTML = config.importIconSvg.trim();
    }
    return icon;
  }

  function createSettingsMenuItemIcon(): HTMLSpanElement {
    const icon = document.createElement("span");
    icon.dataset.pocodexSettingsMenuIcon = "true";
    icon.innerHTML = getSettingsMenuItemIconSvg();
    return icon;
  }

  function getSettingsMenuItemIconSvg(): string {
    return [
      '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">',
      '<path d="M8.69 2.76a1.5 1.5 0 0 1 2.62 0l.38.66a1.5 1.5 0 0 0 1.6.72l.74-.15a1.5 1.5 0 0 1 1.85 1.85l-.15.74a1.5 1.5 0 0 0 .72 1.6l.66.38a1.5 1.5 0 0 1 0 2.62l-.66.38a1.5 1.5 0 0 0-.72 1.6l.15.74a1.5 1.5 0 0 1-1.85 1.85l-.74-.15a1.5 1.5 0 0 0-1.6.72l-.38.66a1.5 1.5 0 0 1-2.62 0l-.38-.66a1.5 1.5 0 0 0-1.6-.72l-.74.15a1.5 1.5 0 0 1-1.85-1.85l.15-.74a1.5 1.5 0 0 0-.72-1.6l-.66-.38a1.5 1.5 0 0 1 0-2.62l.66-.38a1.5 1.5 0 0 0 .72-1.6l-.15-.74a1.5 1.5 0 0 1 1.85-1.85l.74.15a1.5 1.5 0 0 0 1.6-.72l.38-.66ZM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" fill="currentColor"/>',
      "</svg>",
    ].join("");
  }

  function looksLikeAccountMenu(menu: Element): boolean {
    const labels = getMenuItemLabels(menu);
    if (labels.length === 0) {
      return false;
    }

    return labels.some((label) =>
      [
        "log out",
        "sign in with chatgpt",
        "logged in with api key",
        "logged in with copilot",
        "use openai account",
        "use copilot account",
        "upgrade for higher limits",
      ].includes(label),
    );
  }

  function hasMenuItemLabel(menu: Element, expectedText: string): boolean {
    const normalizedExpectedText = normalizeMenuItemText(expectedText);
    return getMenuItemLabels(menu).some((label) => label === normalizedExpectedText);
  }

  function getMenuItemLabels(menu: Element): string[] {
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).flatMap((item) => {
      if (!(item instanceof Element)) {
        return [];
      }

      const label = normalizeMenuItemText(item.textContent);
      return label ? [label] : [];
    });
  }

  function normalizeMenuItemText(value: string | null | undefined): string {
    return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  }

  function dismissActiveMenu(): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
      }),
    );
  }

  function openSettingsExperience(section: string): void {
    if (openCustomSettingsModal(section)) {
      return;
    }

    if (!openSettingsModal(section)) {
      navigateToSettings(section);
      return;
    }

    window.setTimeout(() => {
      if (hasOpenSettingsDialog()) {
        return;
      }
      navigateToSettings(section);
    }, 250);
  }

  function openSettingsModal(section: string): boolean {
    if (typeof window.history.pushState !== "function") {
      return false;
    }

    const nextUrl = new URL(window.location.origin);
    nextUrl.pathname = `/settings/${section}`;

    const currentState = getCurrentHistoryStateRecord();
    const nextIndex = typeof currentState?.idx === "number" ? currentState.idx + 1 : 0;
    const nextHistoryState = {
      ...(currentState ?? {}),
      usr: getCurrentHistoryUserState(),
      key: createHistoryStateKey(),
      idx: nextIndex,
    };

    try {
      window.history.pushState(nextHistoryState, "", nextUrl);
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: nextHistoryState,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  function hasOpenSettingsDialog(): boolean {
    return Boolean(
      document.querySelector(
        '.codex-dialog-overlay, .codex-dialog[role="dialog"], [role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]',
      ),
    );
  }

  function isEmbeddedSettingsView(): boolean {
    const url = new URL(window.location.href);
    return url.searchParams.get(POCODEX_SETTINGS_EMBED_QUERY_PARAM) === POCODEX_SETTINGS_EMBED_VALUE;
  }

  function openCustomSettingsModal(section: string): boolean {
    if (isEmbeddedSettingsView()) {
      return false;
    }

    ensureHostAttached(settingsModalHost);

    const existingFrame = settingsModalHost.querySelector('[data-pocodex-settings-frame="true"]');
    if (isHtmlIFrameElement(existingFrame)) {
      setSettingsModalOpenState(true);
      existingFrame.dataset.pocodexSettingsLoaded = "false";
      existingFrame.src = buildSettingsEmbedUrl(section);
      settingsModalHost.hidden = false;
      return true;
    }

    setSettingsModalOpenState(true);
    settingsModalHost.hidden = false;
    settingsModalHost.replaceChildren();

    const backdrop = document.createElement("div");
    backdrop.dataset.pocodexSettingsBackdrop = "true";

    const dialog = document.createElement("section");
    dialog.dataset.pocodexSettingsDialog = "true";
    dialog.setAttribute?.("role", "dialog");
    dialog.setAttribute?.("aria-modal", "true");
    dialog.setAttribute?.("aria-label", "Settings");

    const header = document.createElement("div");
    header.dataset.pocodexSettingsDialogHeader = "true";

    const title = document.createElement("h2");
    title.textContent = "Settings";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.dataset.pocodexSettingsDialogClose = "true";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => {
      closeCustomSettingsModal();
    });

    header.append(title, closeButton);

    const frame = document.createElement("iframe");
    frame.dataset.pocodexSettingsFrame = "true";
    frame.dataset.pocodexSettingsLoaded = "false";
    frame.src = buildSettingsEmbedUrl(section);
    frame.setAttribute?.("title", "Settings");
    frame.addEventListener("load", () => {
      frame.dataset.pocodexSettingsLoaded = "true";
    });

    dialog.append(header, frame);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) {
        return;
      }
      closeCustomSettingsModal();
    });

    settingsModalHost.appendChild(backdrop);

    if (settingsModalKeydownHandler) {
      window.removeEventListener("keydown", settingsModalKeydownHandler);
    }

    settingsModalKeydownHandler = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      closeCustomSettingsModal();
    };
    window.addEventListener("keydown", settingsModalKeydownHandler);
    return true;
  }

  function closeCustomSettingsModal(): void {
    setSettingsModalOpenState(false);
    settingsModalHost.hidden = true;
    settingsModalHost.replaceChildren();
    if (settingsModalKeydownHandler) {
      window.removeEventListener("keydown", settingsModalKeydownHandler);
      settingsModalKeydownHandler = null;
    }
  }

  function buildSettingsEmbedUrl(section: string): string {
    const nextUrl = new URL("/", window.location.href);
    const currentUrl = new URL(window.location.href);

    currentUrl.searchParams.forEach((value, key) => {
      if (key !== "initialRoute" && key !== POCODEX_SETTINGS_EMBED_QUERY_PARAM) {
        nextUrl.searchParams.set(key, value);
      }
    });

    nextUrl.searchParams.set("initialRoute", `/settings/${section}`);
    nextUrl.searchParams.set(POCODEX_SETTINGS_EMBED_QUERY_PARAM, POCODEX_SETTINGS_EMBED_VALUE);
    return nextUrl.toString();
  }

  function setSettingsModalOpenState(isOpen: boolean): void {
    document.documentElement.dataset.pocodexSettingsModalOpen = isOpen ? "true" : "false";
    if (document.body) {
      document.body.dataset.pocodexSettingsModalOpen = isOpen ? "true" : "false";
    }
  }

  function getCurrentHistoryStateRecord(): Record<string, unknown> | null {
    const state = window.history.state;
    if (!state || typeof state !== "object") {
      return null;
    }

    return state as Record<string, unknown>;
  }

  function getCurrentHistoryUserState(): unknown {
    return getCurrentHistoryStateRecord()?.usr ?? null;
  }

  function createHistoryStateKey(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  function navigateToSettings(section: string): void {
    const nextUrl = new URL("/", window.location.href);
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.forEach((value, key) => {
      if (key !== "initialRoute") {
        nextUrl.searchParams.set(key, value);
      }
    });
    nextUrl.searchParams.set("initialRoute", `/settings/${section}`);
    window.location.assign(nextUrl.toString());
  }

  async function maybePromptForDesktopImport(): Promise<void> {
    if (hasAttemptedDesktopImportPrompt) {
      return;
    }

    hasAttemptedDesktopImportPrompt = true;
    await openDesktopImportDialog("first-run");
  }

  async function openDesktopImportDialog(mode: DesktopImportMode): Promise<void> {
    const result = await listDesktopImportProjects();
    if (!result) {
      return;
    }

    const importableProjects = result.projects.filter(
      (project) => project.available && !project.alreadyImported,
    );
    if (mode === "first-run" && !result.shouldPrompt) {
      return;
    }

    if (!result.found) {
      if (mode === "manual") {
        renderDesktopImportDialog(result, mode);
      }
      return;
    }

    if (importableProjects.length === 0) {
      if (mode === "manual") {
        renderDesktopImportDialog(result, mode);
      }
      return;
    }

    renderDesktopImportDialog(result, mode);
  }

  function renderDesktopImportDialog(
    result: DesktopImportListResult,
    mode: DesktopImportMode,
  ): void {
    ensureHostAttached(importHost);
    importHost.hidden = false;
    importHost.replaceChildren();

    const importableRoots = new Set(
      result.projects
        .filter((project) => project.available && !project.alreadyImported)
        .map((project) => project.root),
    );

    const backdrop = document.createElement("div");
    backdrop.dataset.pocodexImportBackdrop = "true";

    const dialog = document.createElement("section");
    dialog.dataset.pocodexImportDialog = "true";

    const header = document.createElement("div");
    header.dataset.pocodexImportHeader = "true";

    const selectedRoots = new Set<string>();
    const sortedProjects = [...result.projects].sort((left, right) => {
      if (left.activeInCodex !== right.activeInCodex) {
        return left.activeInCodex ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });
    const isManualOnlyDialog = mode === "manual" && sortedProjects.length === 0;
    dialog.dataset.pocodexImportLayout = isManualOnlyDialog ? "manual-only" : "default";

    if (!isManualOnlyDialog) {
      const title = document.createElement("h2");
      title.textContent = mode === "manual" ? "Add workspace" : "Import projects from Codex.app";

      const subtitle = document.createElement("p");
      subtitle.textContent =
        mode === "first-run"
          ? "Choose which saved Codex.app projects you want to add to Pocodex."
          : "Import a saved Codex.app project or enter a local workspace path manually.";

      header.append(title, subtitle);
    }

    const hasDesktopProjects = sortedProjects.length > 0;
    const list = document.createElement("div");
    list.dataset.pocodexImportList = "true";
    if (hasDesktopProjects) {
      for (const project of sortedProjects) {
        const row = document.createElement("label");
        row.dataset.pocodexImportRow = "true";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = project.root;
        checkbox.disabled = !importableRoots.has(project.root);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            selectedRoots.add(project.root);
          } else {
            selectedRoots.delete(project.root);
          }
          importButton.disabled = selectedRoots.size === 0;
        });

        const details = document.createElement("div");
        details.dataset.pocodexImportDetails = "true";

        const label = document.createElement("strong");
        label.textContent = project.label;

        const root = document.createElement("code");
        root.textContent = formatDesktopImportPath(project.root);

        details.append(label, root);

        const badges = document.createElement("div");
        badges.dataset.pocodexImportBadges = "true";
        if (project.activeInCodex) {
          badges.appendChild(createDesktopImportBadge("Active in Codex.app"));
        }
        if (project.alreadyImported) {
          badges.appendChild(createDesktopImportBadge("Already in Pocodex"));
        } else if (!project.available) {
          badges.appendChild(createDesktopImportBadge("Missing on disk"));
        }

        row.append(checkbox, details);
        if (badges.childNodes.length > 0) {
          row.appendChild(badges);
        }
        list.appendChild(row);
      }
    } else if (mode === "manual" && !isManualOnlyDialog) {
      const emptyState = document.createElement("p");
      emptyState.dataset.pocodexImportEmptyState = "true";
      emptyState.dataset.pocodexCompact = "true";
      emptyState.textContent = result.found
        ? "No additional Codex.app projects are available to import."
        : "Codex.app project state was not found on this host.";
      list.appendChild(emptyState);
    }

    const manualSection = document.createElement("form");
    manualSection.dataset.pocodexManualWorkspaceForm = "true";
    if (isManualOnlyDialog) {
      manualSection.dataset.layout = "standalone";
    }

    const manualCopy = document.createElement("div");
    manualCopy.dataset.pocodexManualWorkspaceCopy = "true";

    const manualLabel = document.createElement("label");
    manualLabel.dataset.pocodexManualWorkspaceLabel = "true";
    manualLabel.textContent = "Workspace path";

    const manualHint = document.createElement("p");
    manualHint.dataset.pocodexManualWorkspaceHint = "true";
    manualHint.textContent = "Type a path and choose one of the existing folders below.";

    manualCopy.append(manualLabel, manualHint);

    const manualControls = document.createElement("div");
    manualControls.dataset.pocodexManualWorkspaceControls = "true";

    const manualInput = document.createElement("input");
    manualInput.type = "text";
    manualInput.name = "workspacePath";
    manualInput.placeholder = "/Users/phanlong/Documents/project";
    manualInput.autocomplete = "off";
    manualInput.spellcheck = false;
    manualInput.dataset.pocodexManualWorkspaceInput = "true";

    const homeButton = document.createElement("button");
    homeButton.type = "button";
    homeButton.textContent = "Home";

    manualControls.append(manualInput, homeButton);

    const suggestions = document.createElement("div");
    suggestions.dataset.pocodexManualWorkspaceSuggestions = "true";

    const suggestionsStatus = document.createElement("div");
    suggestionsStatus.dataset.pocodexManualWorkspaceSuggestionsStatus = "true";

    const suggestionsList = document.createElement("div");
    suggestionsList.dataset.pocodexManualWorkspaceSuggestionsList = "true";

    suggestions.append(suggestionsStatus, suggestionsList);

    const manualSubmitButton = document.createElement("button");
    manualSubmitButton.type = "submit";
    manualSubmitButton.dataset.variant = "primary";
    manualSubmitButton.textContent = "Add folder";

    const manualActions = document.createElement("div");
    manualActions.dataset.pocodexManualWorkspaceActions = "true";

    let homeDirectoryPath = "";
    let highlightedSuggestionIndex = -1;
    let suggestionRows: HTMLButtonElement[] = [];
    let autocompleteRequestRevision = 0;
    let autocompleteDebounceId: number | null = null;

    const expandManualWorkspacePath = (path: string): string => {
      const trimmed = path.trim();
      if (!trimmed) {
        return "";
      }

      if (trimmed === "~") {
        return homeDirectoryPath || "";
      }

      if (trimmed.startsWith("~/")) {
        return homeDirectoryPath ? `${homeDirectoryPath}/${trimmed.slice(2)}` : trimmed;
      }

      return trimmed;
    };

    const setManualUiDisabled = (disabled: boolean): void => {
      manualSubmitButton.disabled = disabled;
      homeButton.disabled = disabled;
      manualInput.disabled = disabled;
      importButton.disabled = disabled || selectedRoots.size === 0;
      cancelButton.disabled = disabled;
    };

    const updateManualSubmitState = (): void => {
      manualSubmitButton.disabled = manualInput.value.trim().length === 0;
    };

    const syncSuggestionHighlight = (): void => {
      for (let index = 0; index < suggestionRows.length; index += 1) {
        suggestionRows[index].dataset.active = index === highlightedSuggestionIndex ? "true" : "false";
      }
    };

    const createWorkspaceSuggestionIcon = (): HTMLSpanElement => {
      const icon = document.createElement("span");
      icon.dataset.pocodexManualWorkspaceSuggestionIcon = "true";
      icon.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25a1 1 0 0 1 1-1h3.15c.25 0 .5.1.68.28l.74.74c.19.18.43.28.68.28h4a1 1 0 0 1 1 1v5.7a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5v-7Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
      return icon;
    };

    const applySuggestion = (path: string, submit: boolean): void => {
      manualInput.value = `${path}/`;
      updateManualSubmitState();
      if (submit) {
        void addWorkspacePath(path);
        return;
      }
      void loadAutocompleteSuggestions();
    };

    const renderAutocompleteSuggestions = (
      baseDirectory: string,
      entries: HostDirectoryEntry[],
      query: string,
    ): void => {
      suggestionsList.replaceChildren();
      const fragment = document.createDocumentFragment();
      const normalizedQuery = query.trim().toLowerCase();
      const rows: HTMLButtonElement[] = [];

      const matches = entries
        .filter((entry) => entry.kind === "directory")
        .filter((entry) => (normalizedQuery ? entry.name.toLowerCase().startsWith(normalizedQuery) : true))
        .slice(0, 40);

      if (baseDirectory !== "/" && normalizedQuery.length === 0) {
        const parentPath = getParentDirectoryPath(baseDirectory);
        const parentRow = document.createElement("button");
        parentRow.type = "button";
        parentRow.dataset.pocodexManualWorkspaceSuggestion = "true";
        parentRow.dataset.path = parentPath;

        const parentName = document.createElement("span");
        parentName.dataset.pocodexManualWorkspaceSuggestionName = "true";
        parentName.textContent = "..";

        const parentPathLabel = document.createElement("span");
        parentPathLabel.dataset.pocodexManualWorkspaceSuggestionPath = "true";
        parentPathLabel.textContent = "Parent directory";

        parentRow.append(createWorkspaceSuggestionIcon(), parentName, parentPathLabel);
        parentRow.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        parentRow.addEventListener("click", () => {
          applySuggestion(parentPath, false);
        });
        parentRow.addEventListener("dblclick", () => {
          applySuggestion(parentPath, false);
        });

        fragment.appendChild(parentRow);
        rows.push(parentRow);
      }

      for (const entry of matches) {
        const row = document.createElement("button");
        row.type = "button";
        row.dataset.pocodexManualWorkspaceSuggestion = "true";
        row.dataset.path = entry.path;

        const name = document.createElement("span");
        name.dataset.pocodexManualWorkspaceSuggestionName = "true";
        name.textContent = entry.name;

        const pathLabel = document.createElement("span");
        pathLabel.dataset.pocodexManualWorkspaceSuggestionPath = "true";
        pathLabel.textContent = formatDesktopImportPath(entry.path);

        row.append(createWorkspaceSuggestionIcon(), name, pathLabel);
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        row.addEventListener("click", () => {
          applySuggestion(entry.path, false);
        });
        row.addEventListener("dblclick", () => {
          applySuggestion(entry.path, true);
        });

        fragment.appendChild(row);
        rows.push(row);
      }

      suggestionsList.appendChild(fragment);
      suggestionRows = rows;
      highlightedSuggestionIndex = rows.length > 0 ? 0 : -1;
      syncSuggestionHighlight();

      suggestionsStatus.textContent =
        matches.length > 0
          ? normalizedQuery
            ? `Matching "${query}" in ${formatDesktopImportPath(baseDirectory)}`
            : `Folders in ${formatDesktopImportPath(baseDirectory)}`
          : `No matching folders in ${formatDesktopImportPath(baseDirectory)}.`;
    };

    const loadAutocompleteSuggestions = async (): Promise<void> => {
      const requestRevision = ++autocompleteRequestRevision;
      const rawValue = manualInput.value.trim();
      const expandedValue = expandManualWorkspacePath(rawValue || homeDirectoryPath || "");
      const baseDirectory = getAutocompleteBaseDirectory(expandedValue);
      const query = getAutocompleteQuery(expandedValue);

      suggestions.dataset.loading = "true";
      suggestionsStatus.textContent = "Loading folders...";

      try {
        const result = await callPocodexIpc("host-files/list-directory", { path: baseDirectory });
        if (requestRevision !== autocompleteRequestRevision) {
          return;
        }

        const directory = getHostDirectoryListing(result);
        if (!directory) {
          throw new Error("Host directory response was invalid.");
        }

        renderAutocompleteSuggestions(directory.path, directory.entries, query);
      } catch (error) {
        if (requestRevision !== autocompleteRequestRevision) {
          return;
        }
        suggestionRows = [];
        highlightedSuggestionIndex = -1;
        suggestionsList.replaceChildren();
        suggestionsStatus.textContent =
          error instanceof Error ? error.message : "Failed to load folders.";
      } finally {
        if (requestRevision === autocompleteRequestRevision) {
          suggestions.dataset.loading = "false";
        }
      }
    };

    async function addWorkspacePath(root: string): Promise<void> {
      manualSubmitButton.disabled = true;
      homeButton.disabled = true;
      manualInput.disabled = true;
      importButton.disabled = true;
      cancelButton.disabled = true;
      manualSubmitButton.textContent = "Adding...";

      try {
        const result = await callPocodexIpc("desktop-workspace-import/add-manual", {
          root,
        });
        const addedRoot = getAddedRoot(result);
        closeDesktopImportDialog(false);
        showNotice(
          addedRoot ? `Added workspace ${formatDesktopImportPath(addedRoot)}.` : "Added workspace.",
        );
      } catch (error) {
        manualSubmitButton.disabled = false;
        homeButton.disabled = false;
        manualInput.disabled = false;
        importButton.disabled = selectedRoots.size === 0;
        cancelButton.disabled = false;
        manualSubmitButton.textContent = "Add folder";
        showNotice(error instanceof Error ? error.message : "Failed to add workspace path.");
      }
    }

    manualSection.addEventListener("submit", async (event) => {
      event.preventDefault();
      const root = expandManualWorkspacePath(manualInput.value.trim());
      if (!root) {
        showNotice("Choose a workspace folder to add.");
        return;
      }
      await addWorkspacePath(root);
    });

    manualInput.addEventListener("input", () => {
      updateManualSubmitState();
      if (autocompleteDebounceId !== null) {
        window.clearTimeout(autocompleteDebounceId);
      }
      autocompleteDebounceId = window.setTimeout(() => {
        autocompleteDebounceId = null;
        void loadAutocompleteSuggestions();
      }, 120);
    });

    manualInput.addEventListener("keydown", (event) => {
      switch (event.key) {
        case "ArrowDown":
          if (suggestionRows.length === 0) {
            return;
          }
          event.preventDefault();
          highlightedSuggestionIndex = Math.min(highlightedSuggestionIndex + 1, suggestionRows.length - 1);
          syncSuggestionHighlight();
          return;
        case "ArrowUp":
          if (suggestionRows.length === 0) {
            return;
          }
          event.preventDefault();
          highlightedSuggestionIndex = Math.max(highlightedSuggestionIndex - 1, 0);
          syncSuggestionHighlight();
          return;
        case "Enter":
          if (highlightedSuggestionIndex >= 0 && suggestionRows[highlightedSuggestionIndex]) {
            event.preventDefault();
            applySuggestion(suggestionRows[highlightedSuggestionIndex].dataset.path ?? "", false);
            return;
          }
          break;
        case "Tab":
          if (highlightedSuggestionIndex >= 0 && suggestionRows[highlightedSuggestionIndex]) {
            event.preventDefault();
            applySuggestion(suggestionRows[highlightedSuggestionIndex].dataset.path ?? "", false);
          }
          return;
        default:
          return;
      }
    });

    homeButton.addEventListener("click", () => {
      if (!homeDirectoryPath) {
        return;
      }
      manualInput.value = homeDirectoryPath;
      updateManualSubmitState();
      void loadAutocompleteSuggestions();
    });

    const actions = document.createElement("div");
    actions.dataset.pocodexImportActions = "true";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = mode === "first-run" ? "Skip for now" : "Cancel";
    cancelButton.addEventListener("click", () => {
      closeDesktopImportDialog(mode === "first-run");
    });

    if (isManualOnlyDialog) {
      manualActions.appendChild(manualSubmitButton);
      suggestions.prepend(manualControls);
      suggestions.prepend(manualCopy);
      suggestions.appendChild(manualActions);
      manualSection.appendChild(suggestions);
    } else {
      manualSection.append(manualCopy, manualControls, suggestions);
      manualSection.appendChild(manualSubmitButton);
    }

    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.dataset.variant = "primary";
    importButton.disabled = true;
    importButton.textContent = "Import selected";
    importButton.addEventListener("click", async () => {
      const roots = [...selectedRoots];
      if (roots.length === 0) {
        return;
      }

      importButton.disabled = true;
      manualSubmitButton.disabled = true;
      cancelButton.disabled = true;
      importButton.textContent = "Importing...";

      try {
        const result = await callPocodexIpc("desktop-workspace-import/apply", {
          roots,
        });
        const importedRoots = getImportedRoots(result);
        closeDesktopImportDialog(false);
        if (importedRoots.length > 0) {
          showNotice(
            importedRoots.length === 1
              ? "Imported 1 project from Codex.app."
              : `Imported ${importedRoots.length} projects from Codex.app.`,
          );
        } else {
          showNotice("No new Codex.app projects were imported.");
        }
      } catch (error) {
        importButton.textContent = "Import selected";
        manualSubmitButton.disabled = false;
        cancelButton.disabled = false;
        importButton.disabled = selectedRoots.size === 0;
        showNotice(
          error instanceof Error ? error.message : "Failed to import projects from Codex.app.",
        );
      }
    });

    if (isManualOnlyDialog) {
      dialog.appendChild(manualSection);
    } else if (hasDesktopProjects) {
      actions.append(cancelButton, importButton);
      dialog.append(header, list, manualSection, actions);
    } else {
      actions.append(cancelButton);
      dialog.append(header, list, manualSection, actions);
    }
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) {
        return;
      }
      closeDesktopImportDialog(mode === "first-run");
    });

    importHost.appendChild(backdrop);
    void (async () => {
      try {
        const result = await callPocodexIpc("host-files/list-directory", { path: "" });
        const directory = getHostDirectoryListing(result);
        if (!directory) {
          throw new Error("Host directory response was invalid.");
        }

        homeDirectoryPath = directory.path;
        manualInput.value = directory.path;
        updateManualSubmitState();
        renderAutocompleteSuggestions(directory.path, directory.entries, "");
      } catch (error) {
        suggestionsStatus.textContent =
          error instanceof Error ? error.message : "Failed to load folders.";
      }
    })();
  }

  function formatDesktopImportPath(path: string): string {
    const trimmedPath = path.trim();
    if (trimmedPath.length === 0) {
      return path;
    }

    return trimmedPath.replace(/^\/(?:users|home)\/[^/]+(?=\/|$)/i, "~");
  }

  function createDesktopImportBadge(text: string): HTMLSpanElement {
    const badge = document.createElement("span");
    badge.dataset.pocodexImportBadge = "true";
    badge.textContent = text;
    return badge;
  }

  function closeDesktopImportDialog(markPromptSeen: boolean): void {
    importHost.hidden = true;
    importHost.replaceChildren();
    if (markPromptSeen) {
      void dismissDesktopImportPrompt();
    }
  }

  async function dismissDesktopImportPrompt(): Promise<void> {
    try {
      await callPocodexIpc("desktop-workspace-import/dismiss");
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "Failed to dismiss the Codex.app import prompt.",
      );
    }
  }

  async function listDesktopImportProjects(): Promise<DesktopImportListResult | null> {
    try {
      const result = await callPocodexIpc("desktop-workspace-import/list");
      return isDesktopImportListResult(result) ? result : null;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Failed to load Codex.app projects.");
      return null;
    }
  }

  async function openManualFilePickerDialog(title: string): Promise<HostResolvedFile[]> {
    ensureHostAttached(importHost);
    importHost.hidden = false;
    importHost.replaceChildren();

    return new Promise<HostResolvedFile[]>((resolve) => {
      let isSettled = false;

      const close = (files: HostResolvedFile[]): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        importHost.hidden = true;
        importHost.replaceChildren();
        resolve(files);
      };

      const backdrop = document.createElement("div");
      backdrop.dataset.pocodexImportBackdrop = "true";

      const dialog = document.createElement("section");
      dialog.dataset.pocodexImportDialog = "true";

      const header = document.createElement("div");
      header.dataset.pocodexImportHeader = "true";

      const heading = document.createElement("h2");
      heading.textContent = title;

      const subtitle = document.createElement("p");
      subtitle.textContent =
        "Enter one or more local file paths on the Pocodex host to attach them without restarting.";

      header.append(heading, subtitle);

      const form = document.createElement("form");
      form.dataset.pocodexManualFileForm = "true";

      const label = document.createElement("label");
      label.dataset.pocodexManualFileLabel = "true";
      label.textContent = "File paths";

      const textarea = document.createElement("textarea");
      textarea.name = "filePaths";
      textarea.placeholder = "/absolute/path/to/file.ts\n/absolute/path/to/image.png";
      textarea.autocomplete = "off";
      textarea.spellcheck = false;
      textarea.dataset.pocodexManualFileInput = "true";

      const hint = document.createElement("p");
      hint.dataset.pocodexManualFileHint = "true";
      hint.textContent = "Use one absolute path per line. Files must exist on the Pocodex host.";

      const actions = document.createElement("div");
      actions.dataset.pocodexManualFileActions = "true";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.textContent = "Cancel";
      cancelButton.addEventListener("click", () => {
        close([]);
      });

      const submitButton = document.createElement("button");
      submitButton.type = "submit";
      submitButton.dataset.variant = "primary";
      submitButton.textContent = "Add files";

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const paths = textarea.value
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

        if (paths.length === 0) {
          showNotice("Enter at least one file path to attach.");
          return;
        }

        submitButton.disabled = true;
        cancelButton.disabled = true;
        textarea.disabled = true;
        submitButton.textContent = "Resolving...";

        try {
          const result = await callPocodexIpc("host-files/resolve", { paths });
          const files = getResolvedHostFiles(result);
          close(files);
        } catch (error) {
          submitButton.disabled = false;
          cancelButton.disabled = false;
          textarea.disabled = false;
          submitButton.textContent = "Add files";
          showNotice(error instanceof Error ? error.message : "Failed to resolve file paths.");
        }
      });

      actions.append(cancelButton, submitButton);
      form.append(label, textarea, hint, actions);
      dialog.append(header, form);
      backdrop.appendChild(dialog);
      backdrop.addEventListener("click", (event) => {
        if (event.target !== backdrop) {
          return;
        }
        close([]);
      });

      importHost.appendChild(backdrop);
    });
  }

  async function callPocodexIpc(method: string, params?: unknown): Promise<unknown> {
    const response = await nativeFetch("/ipc-request", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({
        requestId: `pocodex-ipc-${++nextIpcRequestId}`,
        method,
        params,
      }),
    });
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || payload.resultType !== "success") {
      const error =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `IPC request failed (${response.status}).`;
      throw new Error(error);
    }

    return payload.result;
  }

  function getImportedRoots(result: unknown): string[] {
    if (!isRecord(result) || !Array.isArray(result.importedRoots)) {
      return [];
    }

    return result.importedRoots.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }

  function getAddedRoot(result: unknown): string | null {
    return isRecord(result) && typeof result.addedRoot === "string" && result.addedRoot.length > 0
      ? result.addedRoot
      : null;
  }

  function getResolvedHostFiles(result: unknown): HostResolvedFile[] {
    if (!isRecord(result) || !Array.isArray(result.files)) {
      return [];
    }

    return result.files.filter(
      (value): value is HostResolvedFile =>
        isRecord(value) &&
        typeof value.label === "string" &&
        typeof value.path === "string" &&
        typeof value.fsPath === "string",
    );
  }

  function getHostDirectoryListing(result: unknown): {
    path: string;
    entries: HostDirectoryEntry[];
  } | null {
    if (!isRecord(result) || typeof result.path !== "string" || !Array.isArray(result.entries)) {
      return null;
    }

    const entries = result.entries.filter(
      (value): value is HostDirectoryEntry =>
        isRecord(value) &&
        typeof value.name === "string" &&
        typeof value.path === "string" &&
        (value.kind === "directory" || value.kind === "file"),
    );

    return {
      path: result.path,
      entries,
    };
  }

  function getAutocompleteBaseDirectory(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) {
      return "/";
    }

    if (trimmed.endsWith("/")) {
      return trimmed;
    }

    return getParentDirectoryPath(trimmed);
  }

  function getAutocompleteQuery(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed.endsWith("/")) {
      return "";
    }

    const slashIndex = trimmed.lastIndexOf("/");
    return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  }

  function getParentDirectoryPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed === "/") {
      return "/";
    }

    const normalized = trimmed.replace(/\/+$/, "");
    const separatorIndex = normalized.lastIndexOf("/");
    return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
  }

  function getWorkspaceFileRoots(result: unknown): WorkspaceFileRoot[] {
    if (!isRecord(result) || !Array.isArray(result.roots)) {
      return [];
    }

    return result.roots.filter(
      (value): value is WorkspaceFileRoot =>
        isRecord(value) &&
        typeof value.path === "string" &&
        typeof value.label === "string" &&
        typeof value.active === "boolean",
    );
  }

  function getWorkspaceFileDirectoryResult(
    result: unknown,
  ): { root: string; path: string; relativePath: string; entries: WorkspaceFileEntry[] } | null {
    if (
      !isRecord(result) ||
      typeof result.root !== "string" ||
      typeof result.path !== "string" ||
      typeof result.relativePath !== "string" ||
      !Array.isArray(result.entries)
    ) {
      return null;
    }

    return {
      root: result.root,
      path: result.path,
      relativePath: result.relativePath,
      entries: result.entries.filter(
        (value): value is WorkspaceFileEntry =>
          isRecord(value) &&
          typeof value.name === "string" &&
          typeof value.path === "string" &&
          typeof value.relativePath === "string" &&
          (value.kind === "directory" || value.kind === "file"),
      ),
    };
  }

  function getWorkspaceFileSearchResults(result: unknown): WorkspaceFileSearchResult[] {
    if (!isRecord(result) || !Array.isArray(result.files)) {
      return [];
    }

    return result.files.filter(
      (value): value is WorkspaceFileSearchResult =>
        isRecord(value) &&
        typeof value.root === "string" &&
        typeof value.path === "string" &&
        typeof value.relativePath === "string",
    );
  }

  function getWorkspaceFileReadResult(result: unknown): WorkspaceFileReadResult | null {
    if (
      !isRecord(result) ||
      typeof result.root !== "string" ||
      typeof result.path !== "string" ||
      typeof result.relativePath !== "string"
    ) {
      return null;
    }

    if (
      typeof result.kind === "string" &&
      typeof result.mimeType === "string" &&
      typeof result.size === "number"
    ) {
      if (result.kind === "text" && typeof result.contents === "string") {
        return {
          root: result.root,
          path: result.path,
          relativePath: result.relativePath,
          kind: "text",
          mimeType: result.mimeType,
          size: result.size,
          contents: result.contents,
        };
      }

      if (
        (result.kind === "image" || result.kind === "pdf") &&
        typeof result.contentsBase64 === "string"
      ) {
        return {
          root: result.root,
          path: result.path,
          relativePath: result.relativePath,
          kind: result.kind,
          mimeType: result.mimeType,
          size: result.size,
          contentsBase64: result.contentsBase64,
        };
      }

      if (result.kind === "binary") {
        return {
          root: result.root,
          path: result.path,
          relativePath: result.relativePath,
          kind: "binary",
          mimeType: result.mimeType,
          size: result.size,
        };
      }
    }

    if (typeof result.contents !== "string") {
      return null;
    }

    return {
      root: result.root,
      path: result.path,
      relativePath: result.relativePath,
      kind: "text",
      mimeType: "text/plain",
      size: result.contents.length,
      contents: result.contents,
    };
  }

  function isDesktopImportListResult(value: unknown): value is DesktopImportListResult {
    return (
      isRecord(value) &&
      typeof value.found === "boolean" &&
      typeof value.path === "string" &&
      typeof value.promptSeen === "boolean" &&
      typeof value.shouldPrompt === "boolean" &&
      Array.isArray(value.projects)
    );
  }

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
}
