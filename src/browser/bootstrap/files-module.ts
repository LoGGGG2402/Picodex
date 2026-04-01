import type {
  FilesState,
  WorkspaceFileHighlightResult,
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
  WorkspaceFileRoot,
  WorkspaceFileSearchResult,
} from "./types.js";

export function installBootstrapFilesModule(args: {
  filesHost: HTMLDivElement;
  filesState: FilesState;
  ensureHostAttached: (host: HTMLDivElement) => void;
  isHtmlButtonElement: (value: unknown) => value is HTMLButtonElement;
  isHtmlDivElement: (value: unknown) => value is HTMLDivElement;
  showNotice: (message: string) => void;
  callPicodexIpc: (method: string, params?: unknown) => Promise<unknown>;
  formatDesktopImportPath: (path: string) => string;
  getStoredToken: () => string;
  getWorkspaceFileRoots: (result: unknown) => WorkspaceFileRoot[];
  getWorkspaceFileDirectoryResult: (result: unknown) => {
    root: string;
    path: string;
    relativePath: string;
    entries: WorkspaceFileEntry[];
  } | null;
  getWorkspaceFileSearchResults: (result: unknown) => WorkspaceFileSearchResult[];
  getWorkspaceFileReadResult: (result: unknown) => WorkspaceFileReadResult | null;
}): {
  startFilesUiObserver: () => void;
  refreshFilesUi: (root?: Document | Element) => void;
  refreshWorkspaceFileRoots: () => Promise<void>;
  revealWorkspaceFile: (path: string) => Promise<void>;
  toggleFilesPanel: (forceOpen?: boolean) => Promise<void>;
} {
  const {
    filesHost,
    filesState,
    ensureHostAttached,
    isHtmlButtonElement,
    isHtmlDivElement,
    showNotice,
    callPicodexIpc,
    formatDesktopImportPath,
    getStoredToken,
    getWorkspaceFileRoots,
    getWorkspaceFileDirectoryResult,
    getWorkspaceFileSearchResults,
    getWorkspaceFileReadResult,
  } = args;

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
  const PICODEX_THEME_VARIANT_ATTRIBUTE = "data-picodex-theme-variant";

  let isFilesUiObserverStarted = false;
  let isThemeObserverStarted = false;
  let filesSearchTimeoutId: number | null = null;
  let filesSearchRevision = 0;
  const workspacePreviewHighlightCache = new Map<string, { html: string; language: string }>();

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

  function startFilesUiObserver(): void {
    if (!document.body) {
      return;
    }

    if (!isFilesUiObserverStarted) {
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

    if (!isThemeObserverStarted) {
      isThemeObserverStarted = true;
      const themeObserver = new MutationObserver(() => {
        handleWorkspacePreviewThemeChange();
      });

      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: [PICODEX_THEME_VARIANT_ATTRIBUTE],
      });
    }
  }

  function refreshFilesUi(root: Document | Element = document): void {
    maybeInjectFilesToolbarButton(root);
  }

  function maybeInjectFilesToolbarButton(root: Document | Element): void {
    const existingButton = root.querySelector('[data-picodex-files-toggle="true"]');
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
    group.dataset.picodexFilesButtonGroup = "true";
    group.className = anchorGroup.className;

    const button = anchorButton.cloneNode(true);
    if (!isHtmlButtonElement(button)) {
      return;
    }

    button.dataset.picodexFilesToggle = "true";
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
    button.classList.toggle("picodex-files-toggle-active", filesState.open);
  }

  function syncAllFilesToggleButtons(): void {
    document.querySelectorAll('[data-picodex-files-toggle="true"]').forEach((candidate) => {
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
      const result = await callPicodexIpc("workspace-files/list-roots");
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
      const result = await callPicodexIpc("workspace-files/list-directory", {
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
      const result = await callPicodexIpc("workspace-files/read", { path });
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
      const result = await callPicodexIpc("workspace-files/search", {
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
      body.style.removeProperty("--picodex-files-explorer-width");
      return;
    }

    const drawerWidth = Math.round(drawer.getBoundingClientRect().width || getFilesDrawerWidthPx());
    const width = getFilesExplorerWidthPx(drawerWidth);
    body.style.setProperty("--picodex-files-explorer-width", `${width}px`);
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
        const body = drawer.querySelector<HTMLElement>('[data-picodex-files-body="true"]');
        if (body) {
          const explorerWidth = clampFilesExplorerWidth(getFilesExplorerWidthPx(width), width);
          filesState.explorerWidthPx = explorerWidth;
          body.style.setProperty("--picodex-files-explorer-width", `${explorerWidth}px`);
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
        body.style.setProperty("--picodex-files-explorer-width", `${width}px`);
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

  function getWorkspacePreviewExtension(path: string): string {
    return path.split(".").at(-1)?.toLowerCase() ?? "";
  }

  function getWorkspacePreviewLanguageLabel(path: string): string {
    const extension = getWorkspacePreviewExtension(path);
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
    const extension = getWorkspacePreviewExtension(path);
    switch (extension) {
      case "ts":
        return "typescript";
      case "js":
      case "mjs":
      case "cjs":
        return "javascript";
      case "tsx":
        return "tsx";
      case "jsx":
        return "jsx";
      case "json":
        return "json";
      case "jsonc":
        return "jsonc";
      case "json5":
        return "json5";
      case "md":
        return "markdown";
      case "mdx":
        return "mdx";
      case "css":
        return "css";
      case "scss":
      case "sass":
        return "scss";
      case "less":
        return "less";
      case "html":
      case "htm":
        return "html";
      case "svg":
      case "xml":
        return "xml";
      case "vue":
        return "vue";
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
        return "bash";
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
        return "ini";
      case "toml":
        return "toml";
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
      case "tsx":
        return "TypeScript";
      case "javascript":
      case "jsx":
        return "JavaScript";
      case "json":
      case "jsonc":
      case "json5":
        return "JSON";
      case "markdown":
      case "mdx":
        return "Markdown";
      case "css":
      case "scss":
      case "less":
        return "Stylesheet";
      case "html":
      case "xml":
        return "HTML";
      case "vue":
        return "Vue";
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
      case "shellscript":
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
      case "toml":
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
      const input = document.querySelector('[data-picodex-files-search-input="true"]');
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      input.focus();
      input.setSelectionRange(query.length, query.length);
    }, 0);
  }

  function renderWorkspaceFileSearchResults(): HTMLElement {
    const resultList = document.createElement("div");
    resultList.dataset.picodexFilesSearchResults = "true";

    if (filesState.searchLoading) {
      const loading = document.createElement("p");
      loading.dataset.picodexFilesEmptyState = "true";
      loading.textContent = "Searching files...";
      resultList.appendChild(loading);
      return resultList;
    }

    if (filesState.searchResults.length === 0) {
      const emptyState = document.createElement("p");
      emptyState.dataset.picodexFilesEmptyState = "true";
      emptyState.textContent = `No files matched "${filesState.searchQuery.trim()}".`;
      resultList.appendChild(emptyState);
      return resultList;
    }

    filesState.searchResults.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.picodexFilesSearchResult = "true";
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

  async function highlightWorkspacePreview(contents: string, relativePath: string): Promise<void> {
    const revision = ++filesState.previewHighlightRevision;
    filesState.previewHighlightedHtml = "";
    filesState.previewHighlightedLanguage = "";
    const preferredLanguage = getWorkspacePreviewHighlightLanguage(relativePath);
    const themeVariant = getPicodexThemeVariant();

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

    const cacheKey = getWorkspacePreviewHighlightCacheKey(
      contents,
      relativePath,
      preferredLanguage,
      themeVariant,
    );
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

    try {
      const result = getWorkspaceFileHighlightResult(
        await callPicodexIpc("workspace-files/highlight", {
          contents,
          language: preferredLanguage ?? "",
          relativePath,
          themeVariant,
        }),
      );

      if (filesState.previewHighlightRevision !== revision) {
        return;
      }

      if (!result) {
        filesState.previewHighlightedHtml = "";
        filesState.previewHighlightedLanguage = "";
      } else {
        filesState.previewHighlightedHtml = result.html;
        filesState.previewHighlightedLanguage = result.language || preferredLanguage || "";
        rememberWorkspacePreviewHighlightResult(
          cacheKey,
          filesState.previewHighlightedHtml,
          filesState.previewHighlightedLanguage,
        );
      }
    } catch {
      if (filesState.previewHighlightRevision !== revision) {
        return;
      }
      filesState.previewHighlightedHtml = "";
      filesState.previewHighlightedLanguage = "";
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
    themeVariant?: string,
  ): string {
    return `${relativePath}\u0000${language ?? ""}\u0000${themeVariant ?? ""}\u0000${contents.length}\u0000${hashWorkspacePreviewContents(contents)}`;
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

  function getPicodexThemeVariant(): "light" | "dark" {
    return document.documentElement.dataset.picodexThemeVariant === "light" ? "light" : "dark";
  }

  function handleWorkspacePreviewThemeChange(): void {
    if (
      filesState.previewKind !== "text" ||
      !filesState.previewContents ||
      !filesState.previewRelativePath
    ) {
      return;
    }

    void highlightWorkspacePreview(filesState.previewContents, filesState.previewRelativePath);
  }

  function getWorkspaceFileHighlightResult(result: unknown): WorkspaceFileHighlightResult | null {
    if (!result || typeof result !== "object") {
      return null;
    }

    const payload = result as { html?: unknown; language?: unknown };
    return {
      html: typeof payload.html === "string" ? payload.html : "",
      language: typeof payload.language === "string" ? payload.language : "",
    };
  }

  function createWorkspacePreviewLineRow(lineNumberValue: number, contentNode?: Node): HTMLElement {
    const row = document.createElement("div");
    row.dataset.picodexFilesPreviewLine = "true";

    const lineNumber = document.createElement("span");
    lineNumber.dataset.picodexFilesPreviewLineNumber = "true";
    lineNumber.textContent = String(lineNumberValue);

    const lineContent = document.createElement("span");
    lineContent.dataset.picodexFilesPreviewLineContent = "true";

    if (contentNode) {
      lineContent.appendChild(contentNode);
    } else {
      lineContent.textContent = " ";
    }

    row.append(lineNumber, lineContent);
    return row;
  }

  function splitWorkspacePreviewHighlightedLines(highlightedHtml: string): {
    className: string;
    styleText: string;
    lines: Node[];
  } {
    const template = document.createElement("template");
    template.innerHTML = highlightedHtml;

    const pre = template.content.querySelector("pre");
    const code = pre?.querySelector("code");
    const shikiLines = code
      ? Array.from(code.querySelectorAll(":scope > span.line")).map((line) => line.cloneNode(true))
      : [];
    if (shikiLines.length > 0) {
      return {
        className: pre?.className ?? "",
        styleText: pre?.getAttribute("style") ?? "",
        lines: shikiLines,
      };
    }

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

    return {
      className: pre?.className ?? "",
      styleText: pre?.getAttribute("style") ?? "",
      lines: lines.length > 0 ? lines : [document.createDocumentFragment()],
    };
  }

  function renderWorkspacePreviewContent(contents: string): HTMLElement {
    const editor = document.createElement("div");
    editor.dataset.picodexFilesPreviewEditor = "true";
    const totalLines = getWorkspacePreviewLineCount(contents);
    editor.style.setProperty(
      "--picodex-files-line-number-width",
      `${String(totalLines).length + 1}ch`,
    );

    if (filesState.previewHighlightedHtml) {
      const highlighted = splitWorkspacePreviewHighlightedLines(filesState.previewHighlightedHtml);

      highlighted.lines.forEach((fragment, index) => {
        const code = document.createElement("code");
        code.dataset.picodexSyntaxHighlight = "true";
        if (highlighted.className) {
          code.className = highlighted.className;
        }
        if (highlighted.styleText) {
          code.setAttribute("style", highlighted.styleText);
        }
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
      lineContent.textContent = line.length > 0 ? line : " ";
      editor.appendChild(createWorkspacePreviewLineRow(index + 1, lineContent));
    });

    return editor;
  }

  function renderWorkspacePreviewImage(): HTMLElement {
    const stage = document.createElement("div");
    stage.dataset.picodexFilesPreviewMedia = "true";
    stage.dataset.kind = "image";

    if (!filesState.previewObjectUrl) {
      const emptyState = document.createElement("p");
      emptyState.dataset.picodexFilesEmptyState = "true";
      emptyState.textContent = "Image preview is unavailable.";
      stage.appendChild(emptyState);
      return stage;
    }

    const image = document.createElement("img");
    image.dataset.picodexFilesPreviewImage = "true";
    image.alt = getWorkspacePreviewFileName();
    image.src = filesState.previewObjectUrl;
    stage.appendChild(image);
    return stage;
  }

  function renderWorkspacePreviewPdf(): HTMLElement {
    const stage = document.createElement("div");
    stage.dataset.picodexFilesPreviewMedia = "true";
    stage.dataset.kind = "pdf";

    if (!filesState.previewObjectUrl) {
      const emptyState = document.createElement("p");
      emptyState.dataset.picodexFilesEmptyState = "true";
      emptyState.textContent = "PDF preview is unavailable.";
      stage.appendChild(emptyState);
      return stage;
    }

    const frame = document.createElement("iframe");
    frame.dataset.picodexFilesPreviewPdf = "true";
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
    backdrop.dataset.picodexFilesBackdrop = "true";
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) {
        return;
      }
      void toggleFilesPanel(false);
    });

    const drawer = document.createElement("aside");
    drawer.dataset.picodexFilesDrawer = "true";
    applyFilesDrawerWidth(drawer);

    const resizeHandle = document.createElement("button");
    resizeHandle.type = "button";
    resizeHandle.dataset.picodexFilesResizeHandle = "true";
    resizeHandle.setAttribute("aria-label", "Resize files panel");
    installFilesDrawerResizeHandle(resizeHandle, drawer);

    const header = document.createElement("div");
    header.dataset.picodexFilesHeader = "true";

    const titleGroup = document.createElement("div");
    titleGroup.dataset.picodexFilesHeaderCopy = "true";

    const title = document.createElement("h2");
    title.textContent = "Files";

    const subtitle = document.createElement("p");
    subtitle.textContent = filesState.status;

    titleGroup.append(title, subtitle);

    const headerActions = document.createElement("div");
    headerActions.dataset.picodexFilesHeaderActions = "true";

    const rootSelect = document.createElement("select");
    rootSelect.dataset.picodexFilesRootSelect = "true";
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
    body.dataset.picodexFilesBody = "true";
    applyFilesExplorerWidth(body, drawer);

    const explorerPanel = document.createElement("section");
    explorerPanel.dataset.picodexFilesExplorerPanel = "true";

    const explorerHead = document.createElement("div");
    explorerHead.dataset.picodexFilesExplorerHead = "true";

    const explorerHeadCopy = document.createElement("div");
    explorerHeadCopy.dataset.picodexFilesExplorerHeadCopy = "true";

    const explorerHeading = document.createElement("div");
    explorerHeading.dataset.picodexFilesHeading = "true";
    explorerHeading.textContent = "Explorer";

    const explorerRoot = document.createElement("div");
    explorerRoot.dataset.picodexFilesRootLabel = "true";
    explorerRoot.textContent = getSelectedWorkspaceRoot()?.label ?? "No workspace";

    explorerHeadCopy.append(explorerHeading, explorerRoot);

    const explorerSummary = document.createElement("span");
    explorerSummary.dataset.picodexFilesExplorerSummary = "true";
    explorerSummary.textContent = filesState.searchQuery.trim()
      ? `${filesState.searchResults.length} matches`
      : getExplorerSummary();

    const explorerActions = document.createElement("div");
    explorerActions.dataset.picodexFilesSectionActions = "true";

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
    explorerRootPath.dataset.picodexFilesRootPath = "true";
    explorerRootPath.textContent = filesState.selectedRoot
      ? formatDesktopImportPath(filesState.selectedRoot)
      : "No workspace root selected.";

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    searchInput.placeholder = "Search files in this workspace";
    searchInput.value = filesState.searchQuery;
    searchInput.dataset.picodexFilesSearchInput = "true";
    searchInput.addEventListener("input", () => {
      updateWorkspaceFileSearchQuery(searchInput.value);
    });

    const tree = document.createElement("div");
    tree.dataset.picodexFilesTree = "true";

    if (filesState.roots.length === 0) {
      const emptyState = document.createElement("p");
      emptyState.dataset.picodexFilesEmptyState = "true";
      emptyState.textContent = "No workspace roots are available for file browsing.";
      tree.appendChild(emptyState);
    } else if (!filesState.selectedRoot) {
      const emptyState = document.createElement("p");
      emptyState.dataset.picodexFilesEmptyState = "true";
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
    explorerResizeHandle.dataset.picodexFilesInnerResizeHandle = "true";
    explorerResizeHandle.setAttribute("aria-label", "Resize explorer panel");
    installFilesExplorerResizeHandle(explorerResizeHandle, body, drawer);

    const preview = document.createElement("section");
    preview.dataset.picodexFilesPreview = "true";

    const previewHeader = document.createElement("div");
    previewHeader.dataset.picodexFilesPreviewHeader = "true";

    const previewTitleGroup = document.createElement("div");
    previewTitleGroup.dataset.picodexFilesPreviewTitleGroup = "true";

    const previewHeading = document.createElement("div");
    previewHeading.dataset.picodexFilesHeading = "true";
    previewHeading.textContent = "Preview";

    const previewTitle = document.createElement("code");
    previewTitle.dataset.picodexFilesPreviewTitlePath = "true";
    previewTitle.textContent = getActiveWorkspacePreviewPath()
      ? formatDesktopImportPath(getActiveWorkspacePreviewPath() as string)
      : "Select a file from the workspace explorer.";

    const previewActions = document.createElement("div");
    previewActions.dataset.picodexFilesSectionActions = "true";

    const previewMeta = document.createElement("span");
    previewMeta.dataset.picodexFilesPreviewMeta = "true";
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
    previewBody.dataset.picodexFilesPreviewBody = "true";

    if (filesState.previewLoading) {
      const loading = document.createElement("p");
      loading.dataset.picodexFilesEmptyState = "true";
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
        emptyState.dataset.picodexFilesEmptyState = "true";
        emptyState.textContent = "Preview is not available for this file. You can still download it.";
        previewBody.appendChild(emptyState);
      }
    } else {
      const emptyState = document.createElement("p");
      emptyState.dataset.picodexFilesEmptyState = "true";
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
    list.dataset.picodexFilesTreeList = "true";

    if (
      filesState.loadingDirectories.has(directoryPath) &&
      !filesState.directoryEntries.has(directoryPath)
    ) {
      const item = document.createElement("li");
      item.dataset.picodexFilesTreeNode = "true";
      const loading = document.createElement("p");
      loading.dataset.picodexFilesEmptyState = "true";
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
      item.dataset.picodexFilesTreeNode = "true";

      const row = document.createElement("button");
      row.type = "button";
      row.dataset.picodexFilesTreeRow = "true";
      row.dataset.kind = entry.kind;
      row.style.setProperty("--picodex-depth", String(depth));
      if (entry.path === filesState.selectedFilePath) {
        row.dataset.selected = "true";
      }

      const chevron = document.createElement("span");
      chevron.dataset.picodexFilesTreeChevron = "true";
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
      icon.dataset.picodexFilesTreeIcon = "true";
      icon.textContent =
        entry.kind === "directory"
          ? filesState.expandedDirectories.has(entry.path)
            ? "📂"
            : "📁"
          : "📄";

      const name = document.createElement("span");
      name.dataset.picodexFilesTreeName = "true";
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


  return {
    startFilesUiObserver,
    refreshFilesUi,
    refreshWorkspaceFileRoots,
    revealWorkspaceFile,
    toggleFilesPanel,
  };
}
