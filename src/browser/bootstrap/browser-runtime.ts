import { installBootstrapBridgeModule } from "./bridge-module.js";
import { installBootstrapFilesModule } from "./files-module.js";
import { installBootstrapModelConfigModule } from "./model-config-module.js";
import { installBootstrapOpenInAppModule } from "./open-in-app-module.js";
import { installBootstrapSettingsImportModule } from "./settings-import-module.js";
import { installBootstrapStatsigModule } from "./statsig-module.js";
import { installBootstrapThemeModule } from "./theme-module.js";
import type { BootstrapScriptConfig, FilesState, WorkspaceFileEntry } from "./types.js";

export function bootstrapPicodexInBrowser(config: BootstrapScriptConfig): void {
  const POCODEX_STYLESHEET_ID = "picodex-stylesheet";
  const TOKEN_STORAGE_KEY = "__picodex_token";
  const APPEARANCE_THEME_VALUES = new Set(["light", "dark", "system"]);
  const BACKGROUND_SUBAGENTS_STATSIG_GATE = "1221508807";
  const POCODEX_STATSIG_CLASS_PATCH_MARK = "__picodexBackgroundSubagentsPatched";
  const POCODEX_STATSIG_INSTANCE_PATCH_MARK = "__picodexBackgroundSubagentsInstancePatched";

  const toastHost = document.createElement("div");
  const statusHost = document.createElement("div");
  const importHost = document.createElement("div");
  const filesHost = document.createElement("div");
  const modelConfigHost = document.createElement("div");
  const settingsModalHost = document.createElement("div");

  const filesState: FilesState = {
    open: false,
    roots: [],
    selectedRoot: null,
    selectedFilePath: null,
    previewPath: null,
    previewRelativePath: "",
    previewKind: null,
    previewMimeType: "",
    previewSizeBytes: 0,
    previewContents: "",
    previewObjectUrl: null,
    previewHighlightedHtml: "",
    previewHighlightedLanguage: "",
    previewHighlighting: false,
    previewHighlightRevision: 0,
    previewLoading: false,
    isRefreshing: false,
    searchQuery: "",
    searchResults: [],
    searchLoading: false,
    status: "Choose a file from the explorer.",
    drawerWidthPx: null,
    explorerWidthPx: null,
    directoryEntries: new Map<string, WorkspaceFileEntry[]>(),
    expandedDirectories: new Set<string>(),
    loadingDirectories: new Set<string>(),
  };

  toastHost.id = "picodex-toast-host";
  statusHost.id = "picodex-status-host";
  importHost.id = "picodex-import-host";
  filesHost.id = "picodex-files-host";
  modelConfigHost.id = "picodex-model-config-host";
  settingsModalHost.id = "picodex-settings-modal-host";
  importHost.hidden = true;
  filesHost.hidden = true;
  modelConfigHost.hidden = true;
  settingsModalHost.hidden = true;
  document.documentElement.dataset.picodex = "true";
  installClipboardWriteTextShim();

  const statsigApi = installBootstrapStatsigModule({
    backgroundSubagentsStatsigGate: BACKGROUND_SUBAGENTS_STATSIG_GATE,
    statsigClassPatchMark: POCODEX_STATSIG_CLASS_PATCH_MARK,
    statsigInstancePatchMark: POCODEX_STATSIG_INSTANCE_PATCH_MARK,
  });
  const themeApi = installBootstrapThemeModule({
    appearanceThemeValues: APPEARANCE_THEME_VALUES,
    parseHostFetchBody,
  });
  const settingsImportApi = installBootstrapSettingsImportModule({
    config,
    importHost,
    settingsModalHost,
    showNotice,
    ensureHostAttached,
    isPrimaryUnmodifiedClick,
    isHtmlIFrameElement,
    isRecord,
  });
  const filesApi = installBootstrapFilesModule({
    filesHost,
    filesState,
    ensureHostAttached,
    isHtmlButtonElement,
    isHtmlDivElement,
    showNotice,
    callPicodexIpc: settingsImportApi.callPicodexIpc,
    formatDesktopImportPath: settingsImportApi.formatDesktopImportPath,
    getStoredToken,
    getWorkspaceFileRoots: settingsImportApi.getWorkspaceFileRoots,
    getWorkspaceFileDirectoryResult: settingsImportApi.getWorkspaceFileDirectoryResult,
    getWorkspaceFileSearchResults: settingsImportApi.getWorkspaceFileSearchResults,
    getWorkspaceFileReadResult: settingsImportApi.getWorkspaceFileReadResult,
  });
  const modelConfigApi = installBootstrapModelConfigModule({
    modelConfigHost,
    showNotice,
    ensureHostAttached,
    isRecord,
    callPicodexIpc: settingsImportApi.callPicodexIpc,
  });
  const openInAppApi = installBootstrapOpenInAppModule();

  const bridgeApi = installBootstrapBridgeModule({
    config,
    filesState,
    showNotice,
    setConnectionStatus,
    clearConnectionStatus,
    reloadStylesheet,
    observePicodexThemeHostFetch: themeApi.observePicodexThemeHostFetch,
    observePicodexThemeHostFetchResponse: themeApi.observePicodexThemeHostFetchResponse,
    syncPicodexThemeFromPersistedAtomState: themeApi.syncPicodexThemeFromPersistedAtomState,
    syncPicodexThemeFromPersistedAtomUpdate: themeApi.syncPicodexThemeFromPersistedAtomUpdate,
    openDesktopImportDialog: settingsImportApi.openDesktopImportDialog,
    maybePromptForDesktopImport: settingsImportApi.maybePromptForDesktopImport,
    openBrowserAttachmentPickerDialog: settingsImportApi.openBrowserAttachmentPickerDialog,
    openManualFilePickerDialog: settingsImportApi.openManualFilePickerDialog,
    refreshWorkspaceFileRoots: filesApi.refreshWorkspaceFileRoots,
    revealWorkspaceFile: filesApi.revealWorkspaceFile,
    isMobileSidebarViewport: () => false,
  });

  statsigApi.installStatsigBackgroundSubagentsOverride();

  runWhenDocumentReady(() => {
    ensureStylesheetLink(config.stylesheetHref);
    themeApi.applyPicodexThemePreference("system");
    themeApi.installPicodexSystemThemeListener();
    installBrowserSafeShortcutRemaps();
    ensureHostAttached(toastHost);
    ensureHostAttached(statusHost);
    ensureHostAttached(importHost);
    ensureHostAttached(filesHost);
    ensureHostAttached(modelConfigHost);
    ensureHostAttached(settingsModalHost);
    openInAppApi.startOpenInAppObserver();
    settingsImportApi.startImportUiObserver();
    filesApi.startFilesUiObserver();
    modelConfigApi.startModelConfigObserver();
    settingsImportApi.removeInjectedSettingsButtons();
  });

  function runWhenDocumentReady(callback: () => void): void {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function installBrowserSafeShortcutRemaps(): void {
    const isMac = /\bMac/i.test(navigator.platform);
    const remapHandler = (event: KeyboardEvent) => {
      if (!event.isTrusted) {
        return;
      }

      const remappedAction = getBrowserSafeShortcutAction(event, isMac);
      if (!remappedAction) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (remappedAction.type === "open-model-config") {
        modelConfigApi.openModelConfigFromShortcut();
        return;
      }

      if (remappedAction.type === "open-files-panel") {
        void filesApi.toggleFilesPanel();
        return;
      }

      bridgeApi?.dispatchHostMessage(remappedAction);
    };

    window.addEventListener("keydown", remapHandler, true);
  }

  function getBrowserSafeShortcutAction(
    event: KeyboardEvent,
    isMac: boolean,
  ):
    | { type: "navigate-to-route"; path: "/settings/general-settings" }
    | { type: "open-files-panel" }
    | { type: "open-model-config" }
    | { type: "toggle-sidebar" }
    | { type: "toggle-terminal" }
    | null {
    const normalizedKey = event.key.toLowerCase();
    if (event.repeat) {
      return null;
    }

    const matchesBrowserSafePrimaryShortcut = isMac
      ? event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey
      : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;

    if (!matchesBrowserSafePrimaryShortcut) {
      return null;
    }

    if (normalizedKey === "b") {
      return { type: "toggle-sidebar" };
    }

    if (normalizedKey === "j") {
      return { type: "toggle-terminal" };
    }

    if (normalizedKey === "e") {
      return { type: "open-files-panel" };
    }

    if (normalizedKey === "m") {
      return { type: "open-model-config" };
    }

    if (event.code === "Comma") {
      return { type: "navigate-to-route", path: "/settings/general-settings" };
    }

    return null;
  }

  function installClipboardWriteTextShim(): void {
    if (typeof navigator === "undefined") {
      return;
    }

    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === "function") {
      return;
    }

    const shim = {
      writeText(text: string): Promise<void> {
        return fallbackWriteText(text);
      },
    };

    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: shim,
      });
      return;
    } catch {
      // Fall through to direct assignment when the property can't be redefined.
    }

    try {
      Object.assign(navigator, {
        clipboard: shim,
      });
    } catch {
      // Ignore. The app will continue using any existing clipboard implementation.
    }
  }

  async function fallbackWriteText(text: string): Promise<void> {
    if (copyTextWithExecCommand(text)) {
      return;
    }

    throw new Error("Clipboard is not available in this browser.");
  }

  function copyTextWithExecCommand(text: string): boolean {
    if (!document.body || typeof document.execCommand !== "function") {
      return false;
    }

    const textArea = document.createElement("textarea");
    const activeElement = document.activeElement;
    const selection = window.getSelection();
    const previousRange =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;

    textArea.value = text;
    textArea.setAttribute("readonly", "true");
    textArea.setAttribute("aria-hidden", "true");
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.opacity = "0";
    textArea.style.pointerEvents = "none";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, text.length);

    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textArea.remove();
      if (selection) {
        selection.removeAllRanges();
        if (previousRange) {
          selection.addRange(previousRange);
        }
      }
      if (activeElement instanceof HTMLElement) {
        activeElement.focus();
      }
    }
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
        showNotice("Failed to reload Picodex CSS.");
      },
      { once: true },
    );
    currentLink.after(nextLink);
  }

  function showNotice(message: string): void {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.dataset.picodexToast = "true";
    ensureHostAttached(toastHost);
    toastHost.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 5000);
  }

  function setConnectionStatus(message: string, options: { mode?: string } = {}): void {
    ensureHostAttached(statusHost);
    statusHost.replaceChildren();
    statusHost.dataset.mode = options.mode ?? "blocking";
    statusHost.hidden = false;

    const card = document.createElement("div");
    card.dataset.picodexStatusCard = "true";

    const title = document.createElement("strong");
    title.textContent = "Picodex";

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

  function getStoredToken(): string {
    const url = new URL(window.location.href);
    const tokenFromQuery = url.searchParams.get("token");
    if (tokenFromQuery) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, tokenFromQuery);
      return tokenFromQuery;
    }
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
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
}
