import { installBootstrapBridgeModule } from "./bridge-module.js";
import { installBootstrapFilesModule } from "./files-module.js";
import { installBootstrapMobileSidebarModule } from "./mobile-sidebar-module.js";
import { installBootstrapOpenInAppModule } from "./open-in-app-module.js";
import { installBootstrapSettingsImportModule } from "./settings-import-module.js";
import { installBootstrapStatsigModule } from "./statsig-module.js";
import { installBootstrapThemeModule } from "./theme-module.js";
import type { BootstrapScriptConfig, FilesState, WorkspaceFileEntry } from "./types.js";

export function bootstrapPocodexInBrowser(config: BootstrapScriptConfig): void {
  const POCODEX_STYLESHEET_ID = "pocodex-stylesheet";
  const TOKEN_STORAGE_KEY = "__pocodex_token";
  const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 640px), (pointer: coarse) and (max-width: 900px)";
  const APPEARANCE_THEME_VALUES = new Set(["light", "dark", "system"]);
  const POCODEX_SETTINGS_EMBED_QUERY_PARAM = "pocodexEmbed";
  const POCODEX_SETTINGS_EMBED_VALUE = "settings-modal";
  const BACKGROUND_SUBAGENTS_STATSIG_GATE = "1221508807";
  const POCODEX_STATSIG_CLASS_PATCH_MARK = "__pocodexBackgroundSubagentsPatched";
  const POCODEX_STATSIG_INSTANCE_PATCH_MARK = "__pocodexBackgroundSubagentsInstancePatched";

  const toastHost = document.createElement("div");
  const statusHost = document.createElement("div");
  const importHost = document.createElement("div");
  const filesHost = document.createElement("div");
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

  toastHost.id = "pocodex-toast-host";
  statusHost.id = "pocodex-status-host";
  importHost.id = "pocodex-import-host";
  filesHost.id = "pocodex-files-host";
  settingsModalHost.id = "pocodex-settings-modal-host";
  importHost.hidden = true;
  filesHost.hidden = true;
  settingsModalHost.hidden = true;
  document.documentElement.dataset.pocodex = "true";

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
    config,
    filesHost,
    filesState,
    ensureHostAttached,
    isHtmlButtonElement,
    isHtmlDivElement,
    showNotice,
    callPocodexIpc: settingsImportApi.callPocodexIpc,
    formatDesktopImportPath: settingsImportApi.formatDesktopImportPath,
    getStoredToken,
    getWorkspaceFileRoots: settingsImportApi.getWorkspaceFileRoots,
    getWorkspaceFileDirectoryResult: settingsImportApi.getWorkspaceFileDirectoryResult,
    getWorkspaceFileSearchResults: settingsImportApi.getWorkspaceFileSearchResults,
    getWorkspaceFileReadResult: settingsImportApi.getWorkspaceFileReadResult,
  });
  const openInAppApi = installBootstrapOpenInAppModule();

  let bridgeApi: { dispatchHostMessage: (message: unknown) => void } | null = null;
  const mobileApi = installBootstrapMobileSidebarModule({
    mobileSidebarMediaQuery: MOBILE_SIDEBAR_MEDIA_QUERY,
    dispatchHostMessage: (message) => {
      bridgeApi?.dispatchHostMessage(message);
    },
    isPrimaryUnmodifiedClick,
  });
  bridgeApi = installBootstrapBridgeModule({
    config,
    filesState,
    showNotice,
    setConnectionStatus,
    clearConnectionStatus,
    reloadStylesheet,
    observePocodexThemeHostFetch: themeApi.observePocodexThemeHostFetch,
    observePocodexThemeHostFetchResponse: themeApi.observePocodexThemeHostFetchResponse,
    syncPocodexThemeFromPersistedAtomState: themeApi.syncPocodexThemeFromPersistedAtomState,
    syncPocodexThemeFromPersistedAtomUpdate: themeApi.syncPocodexThemeFromPersistedAtomUpdate,
    openDesktopImportDialog: settingsImportApi.openDesktopImportDialog,
    maybePromptForDesktopImport: settingsImportApi.maybePromptForDesktopImport,
    openManualFilePickerDialog: settingsImportApi.openManualFilePickerDialog,
    refreshWorkspaceFileRoots: filesApi.refreshWorkspaceFileRoots,
    revealWorkspaceFile: filesApi.revealWorkspaceFile,
    isMobileSidebarViewport: mobileApi.isMobileSidebarViewport,
  });

  statsigApi.installStatsigBackgroundSubagentsOverride();

  runWhenDocumentReady(() => {
    ensureStylesheetLink(config.stylesheetHref);
    themeApi.applyPocodexThemePreference("system");
    themeApi.installPocodexSystemThemeListener();
    ensureHostAttached(toastHost);
    ensureHostAttached(statusHost);
    ensureHostAttached(importHost);
    ensureHostAttached(filesHost);
    ensureHostAttached(settingsModalHost);
    openInAppApi.startOpenInAppObserver();
    settingsImportApi.startImportUiObserver();
    filesApi.startFilesUiObserver();
    if (isEmbeddedSettingsView()) {
      settingsImportApi.installEmbeddedSettingsChromeCleanup();
    } else {
      settingsImportApi.removeInjectedSettingsButtons();
      settingsImportApi.installNativeSettingsOverride();
    }
    mobileApi.installMobileSidebarThreadNavigationClose();
  });

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

  function setConnectionStatus(message: string, options: { mode?: string } = {}): void {
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

  function isEmbeddedSettingsView(): boolean {
    const url = new URL(window.location.href);
    return url.searchParams.get(POCODEX_SETTINGS_EMBED_QUERY_PARAM) === POCODEX_SETTINGS_EMBED_VALUE;
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
