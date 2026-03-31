import type {
  BootstrapScriptConfig,
  DesktopImportListResult,
  DesktopImportMode,
  HostDirectoryEntry,
  HostResolvedFile,
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
  WorkspaceFileRoot,
  WorkspaceFileSearchResult,
} from "./types.js";

export function installBootstrapSettingsImportModule(args: {
  config: BootstrapScriptConfig;
  importHost: HTMLDivElement;
  settingsModalHost: HTMLDivElement;
  showNotice: (message: string) => void;
  ensureHostAttached: (host: HTMLDivElement) => void;
  isPrimaryUnmodifiedClick: (event: MouseEvent) => boolean;
  isHtmlIFrameElement: (value: unknown) => value is HTMLIFrameElement;
  isRecord: (value: unknown) => value is Record<string, unknown>;
}): {
  startImportUiObserver: () => void;
  removeInjectedSettingsButtons: (root?: Document | Element) => void;
  installEmbeddedSettingsChromeCleanup: () => void;
  installNativeSettingsOverride: () => void;
  maybePromptForDesktopImport: () => Promise<void>;
  openDesktopImportDialog: (mode: DesktopImportMode) => Promise<void>;
  openManualFilePickerDialog: (title: string) => Promise<HostResolvedFile[]>;
  callPocodexIpc: (method: string, params?: unknown) => Promise<unknown>;
  formatDesktopImportPath: (path: string) => string;
  getWorkspaceFileRoots: (result: unknown) => WorkspaceFileRoot[];
  getWorkspaceFileDirectoryResult: (result: unknown) => {
    root: string;
    path: string;
    relativePath: string;
    entries: WorkspaceFileEntry[];
  } | null;
  getWorkspaceFileSearchResults: (result: unknown) => WorkspaceFileSearchResult[];
  getWorkspaceFileReadResult: (result: unknown) => WorkspaceFileReadResult | null;
} {
  const {
    config,
    importHost,
    settingsModalHost,
    showNotice,
    ensureHostAttached,
    isPrimaryUnmodifiedClick,
    isHtmlIFrameElement,
    isRecord,
  } = args;

  const POCODEX_SETTINGS_EMBED_QUERY_PARAM = "pocodexEmbed";
  const POCODEX_SETTINGS_EMBED_VALUE = "settings-modal";

  let isImportUiObserverStarted = false;
  let isNativeSettingsOverrideInstalled = false;
  let hasAttemptedDesktopImportPrompt = false;
  let settingsModalKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
  let nextIpcRequestId = 0;
  const nativeFetch: typeof window.fetch = window.fetch.bind(window);
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


  return {
    startImportUiObserver,
    removeInjectedSettingsButtons,
    installEmbeddedSettingsChromeCleanup,
    installNativeSettingsOverride,
    maybePromptForDesktopImport,
    openDesktopImportDialog,
    openManualFilePickerDialog,
    callPocodexIpc,
    formatDesktopImportPath,
    getWorkspaceFileRoots,
    getWorkspaceFileDirectoryResult,
    getWorkspaceFileSearchResults,
    getWorkspaceFileReadResult,
  };
}
