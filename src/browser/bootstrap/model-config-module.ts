export function installBootstrapModelConfigModule(args: {
  modelConfigHost: HTMLDivElement;
  showNotice: (message: string) => void;
  ensureHostAttached: (host: HTMLDivElement) => void;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  callPicodexIpc: (method: string, params?: unknown) => Promise<unknown>;
}): {
  startModelConfigObserver: () => void;
  openModelConfigFromShortcut: () => void;
} {
  const {
    modelConfigHost,
    showNotice,
    ensureHostAttached,
    isRecord,
    callPicodexIpc,
  } = args;

  type ModelReasoningEffort = string;
  type ModelReasoningSummary = "auto" | "concise" | "detailed" | "none";
  type ModelVerbosity = "low" | "medium" | "high";
  type ModelServiceTier = "fast" | "flex";
  type ProviderConfig = {
    id: string;
    name: string | null;
    baseUrl: string | null;
    envKey: string | null;
    wireApi: string | null;
    supportsWebsockets: boolean | null;
  };
  type ModelOption = {
    id: string;
    model: string;
    displayName: string;
    description: string;
    defaultReasoningEffort: ModelReasoningEffort | null;
    supportedReasoningEfforts: Array<{
      effort: ModelReasoningEffort;
      description: string;
    }>;
  };
  type ConfigSnapshot = {
    model: string | null;
    reviewModel: string | null;
    modelProvider: string | null;
    modelProviderName: string | null;
    modelContextWindow: number | null;
    modelAutoCompactTokenLimit: number | null;
    serviceTier: ModelServiceTier | null;
    modelReasoningEffort: ModelReasoningEffort | null;
    modelReasoningSummary: ModelReasoningSummary | null;
    modelVerbosity: ModelVerbosity | null;
    profile: string | null;
    profilesJson: string;
    providerConfigs: ProviderConfig[];
    userConfigPath: string | null;
    userConfigVersion: string | null;
  };
  type SaveStatusTone = "neutral" | "success" | "error";

  // Exact values from Codex upstream:
  // `codex-rs/protocol/src/config_types.rs` -> `ReasoningSummary`
  const ALL_REASONING_SUMMARIES: ModelReasoningSummary[] = [
    "auto",
    "concise",
    "detailed",
    "none",
  ];
  // Exact values from Codex upstream:
  // `codex-rs/protocol/src/config_types.rs` -> `Verbosity`
  const ALL_VERBOSITIES: ModelVerbosity[] = ["low", "medium", "high"];
  // Exact values from Codex upstream:
  // `codex-rs/protocol/src/config_types.rs` -> `ServiceTier`
  const ALL_SERVICE_TIERS: ModelServiceTier[] = ["fast", "flex"];
  const EXCLUDED_BUTTON_LABELS = new Set([
    "add files and more",
    "custom (config.toml)",
    "local",
    "main",
    "settings",
  ]);

  let isObserverStarted = false;
  let currentBackdrop: HTMLDivElement | null = null;
  let currentPanel: HTMLDivElement | null = null;
  let currentAnchor: HTMLElement | null = null;
  let currentRepositionHandler: (() => void) | null = null;
  let currentKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
  let activeRenderToken = 0;
  let knownModels: ModelOption[] = [];
  let currentConfiguredModelLabel: string | null = null;

  function startModelConfigObserver(): void {
    if (isObserverStarted || !document.body) {
      return;
    }

    isObserverStarted = true;
    refreshModelButtons(document);

    const observer = new MutationObserver(() => {
      refreshModelButtons(document);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function refreshModelButtons(root: Document | Element = document): void {
    root.querySelectorAll<HTMLElement>('button, [role="button"]').forEach((candidate) => {
      if (!looksLikeComposerModelButton(candidate)) {
        return;
      }

      candidate.dataset.picodexModelConfigTrigger = "true";
      candidate.removeAttribute("title");
      if (
        currentConfiguredModelLabel &&
        !buttonAlreadyDisplaysModelLabel(candidate, currentConfiguredModelLabel)
      ) {
        updateModelButtonText(candidate, currentConfiguredModelLabel);
      }
    });
  }

  function looksLikeComposerModelButton(element: HTMLElement): boolean {
    if (element.closest("#picodex-model-config-host")) {
      return false;
    }

    if (element.dataset.picodexModelConfigTrigger === "true") {
      return findComposerActionRegion(element) !== null;
    }

    const label = normalizeLabel(element.getAttribute("aria-label") ?? element.textContent);
    if (!label || EXCLUDED_BUTTON_LABELS.has(label)) {
      return false;
    }

    if (!isModelishLabel(label)) {
      return false;
    }

    return findComposerActionRegion(element) !== null;
  }

  function isModelishLabel(label: string): boolean {
    if (knownModels.some((model) => normalizedModelLabels(model).has(label))) {
      return true;
    }

    return /^(gpt|o[1-9]|codex|claude|gemini|llama|mistral|qwen|deepseek|grok)[a-z0-9.+\- ]*$/i.test(
      label,
    );
  }

  function normalizedModelLabels(model: ModelOption): Set<string> {
    return new Set([
      normalizeLabel(model.id),
      normalizeLabel(model.model),
      normalizeLabel(model.displayName),
    ]);
  }

  function findComposerActionRegion(element: HTMLElement): HTMLElement | null {
    let current: HTMLElement | null = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const buttons = Array.from(current.querySelectorAll("button"));
      const hasAddFilesTrigger = buttons.some(
        (button) =>
          normalizeLabel(button.getAttribute("aria-label") ?? button.textContent) ===
          "add files and more",
      );
      if (hasAddFilesTrigger) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  async function openModelConfig(anchor: HTMLElement): Promise<void> {
    closeModelConfig();
    currentAnchor = anchor;
    activeRenderToken += 1;
    const renderToken = activeRenderToken;

    ensureHostAttached(modelConfigHost);
    modelConfigHost.hidden = false;
    document.documentElement.dataset.picodexModelConfigOpen = "true";

    const backdrop = document.createElement("div");
    backdrop.dataset.picodexModelConfigBackdrop = "true";

    const panel = document.createElement("div");
    panel.dataset.picodexModelConfigPanel = "true";
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Model configuration");

    backdrop.appendChild(panel);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        closeModelConfig();
      }
    });

    currentBackdrop = backdrop;
    currentPanel = panel;
    modelConfigHost.replaceChildren(backdrop);
    renderLoadingState(panel);
    installGlobalCloseHandlers();
    positionPanel(panel, anchor);
    queueMicrotask(() => {
      positionPanel(panel, anchor);
      panel.focus();
    });

    try {
      if (renderToken !== activeRenderToken || currentPanel !== panel) {
        return;
      }

      const { config, models } = await loadModelConfigData();
      renderModelConfigPanel(panel, anchor, config, models);
      positionPanel(panel, anchor);
      refreshModelButtons(document);
    } catch (error) {
      if (renderToken !== activeRenderToken || currentPanel !== panel) {
        return;
      }

      renderErrorState(
        panel,
        error instanceof Error ? error.message : "Failed to load model configuration.",
      );
      positionPanel(panel, anchor);
    }
  }

  function openModelConfigFromShortcut(): void {
    const anchor =
      document.activeElement instanceof HTMLElement && document.contains(document.activeElement)
        ? document.activeElement
        : document.body;
    if (!anchor) {
      return;
    }

    void openModelConfig(anchor);
  }

  function closeModelConfig(): void {
    activeRenderToken += 1;
    currentAnchor = null;
    currentPanel = null;
    currentBackdrop = null;
    modelConfigHost.hidden = true;
    modelConfigHost.replaceChildren();
    delete document.documentElement.dataset.picodexModelConfigOpen;

    if (currentRepositionHandler) {
      window.removeEventListener("resize", currentRepositionHandler);
      window.removeEventListener("scroll", currentRepositionHandler, true);
      currentRepositionHandler = null;
    }

    if (currentKeydownHandler) {
      window.removeEventListener("keydown", currentKeydownHandler);
      currentKeydownHandler = null;
    }
  }

  function installGlobalCloseHandlers(): void {
    if (currentRepositionHandler) {
      window.removeEventListener("resize", currentRepositionHandler);
      window.removeEventListener("scroll", currentRepositionHandler, true);
    }

    currentRepositionHandler = () => {
      if (currentPanel && currentAnchor) {
        positionPanel(currentPanel, currentAnchor);
      }
    };

    window.addEventListener("resize", currentRepositionHandler);
    window.addEventListener("scroll", currentRepositionHandler, true);

    if (currentKeydownHandler) {
      window.removeEventListener("keydown", currentKeydownHandler);
    }

    currentKeydownHandler = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModelConfig();
      }
    };

    window.addEventListener("keydown", currentKeydownHandler);
  }

  function renderLoadingState(panel: HTMLDivElement): void {
    const header = document.createElement("div");
    header.dataset.picodexModelConfigHeader = "true";

    const titleGroup = document.createElement("div");
    titleGroup.dataset.picodexModelConfigTitle = "true";
    const title = document.createElement("strong");
    title.textContent = "Model config";
    const subtitle = document.createElement("p");
    subtitle.textContent = "Loading effective config and available models...";
    titleGroup.append(title, subtitle);

    const closeButton = createActionButton("Close", () => {
      closeModelConfig();
    });
    closeButton.dataset.variant = "ghost";

    header.append(titleGroup, closeButton);

    const body = document.createElement("div");
    body.dataset.picodexModelConfigBody = "true";
    const loading = document.createElement("p");
    loading.dataset.picodexModelConfigEmpty = "true";
    loading.textContent = "Loading model configuration...";
    body.appendChild(loading);

    panel.replaceChildren(header, body);
  }

  function renderErrorState(panel: HTMLDivElement, message: string): void {
    const header = document.createElement("div");
    header.dataset.picodexModelConfigHeader = "true";

    const titleGroup = document.createElement("div");
    titleGroup.dataset.picodexModelConfigTitle = "true";
    const title = document.createElement("strong");
    title.textContent = "Model config";
    const subtitle = document.createElement("p");
    subtitle.textContent = "Unable to read the current app-server configuration.";
    titleGroup.append(title, subtitle);

    const closeButton = createActionButton("Close", () => {
      closeModelConfig();
    });
    closeButton.dataset.variant = "ghost";
    header.append(titleGroup, closeButton);

    const body = document.createElement("div");
    body.dataset.picodexModelConfigBody = "true";
    const errorMessage = document.createElement("p");
    errorMessage.dataset.picodexModelConfigEmpty = "true";
    errorMessage.textContent = message;
    body.appendChild(errorMessage);

    panel.replaceChildren(header, body);
  }

  function renderModelConfigPanel(
    panel: HTMLDivElement,
    anchor: HTMLElement,
    config: ConfigSnapshot,
    models: ModelOption[],
    saveStatusState: {
      message: string;
      tone?: SaveStatusTone;
    } = {
      message: "Writes to the user config layer.",
      tone: "neutral",
    },
  ): void {
    const header = document.createElement("div");
    header.dataset.picodexModelConfigHeader = "true";

    const titleGroup = document.createElement("div");
    titleGroup.dataset.picodexModelConfigTitle = "true";

    const title = document.createElement("strong");
    title.textContent = "Model defaults";

    const subtitle = document.createElement("p");
    subtitle.textContent = config.userConfigPath
      ? config.userConfigPath
      : "~/.codex/config.toml";

    titleGroup.append(title, subtitle);

    const closeButton = createActionButton("Close", () => {
      closeModelConfig();
    });
    closeButton.dataset.variant = "ghost";
    header.append(titleGroup, closeButton);

    const body = document.createElement("form");
    body.dataset.picodexModelConfigBody = "true";
    body.dataset.picodexModelConfigForm = "true";
    const shell = document.createElement("div");
    shell.dataset.picodexModelConfigShell = "true";
    const sidebar = document.createElement("aside");
    sidebar.dataset.picodexModelConfigSidebar = "true";
    const main = document.createElement("div");
    main.dataset.picodexModelConfigMain = "true";

    const summaryHero = document.createElement("section");
    summaryHero.dataset.picodexModelConfigHero = "true";
    const summaryKicker = document.createElement("span");
    summaryKicker.dataset.picodexModelConfigHeroKicker = "true";
    summaryKicker.textContent = "Current default";
    const summaryTitle = document.createElement("strong");
    summaryTitle.dataset.picodexModelConfigHeroTitle = "true";
    const summaryBadges = document.createElement("div");
    summaryBadges.dataset.picodexModelConfigBadges = "true";
    const summaryFacts = document.createElement("div");
    summaryFacts.dataset.picodexModelConfigFacts = "true";
    summaryHero.append(summaryKicker, summaryTitle, summaryBadges, summaryFacts);
    sidebar.append(summaryHero);

    const defaultsSection = createFormCard(
      "Defaults",
    );
    const defaultsGrid = document.createElement("div");
    defaultsGrid.dataset.picodexModelConfigGrid = "true";
    defaultsGrid.dataset.layout = "defaults";

    const modelSelect = createSelectControl(
      models.map((model) => ({
        value: model.id,
        label: model.displayName,
      })),
      config.model,
      "Use app default",
    );
    const reviewModelSelect = createSelectControl(
      models.map((model) => ({
        value: model.id,
        label: model.displayName,
      })),
      config.reviewModel,
      "Follow main model",
    );
    const providerInput = createTextInput(config.modelProvider ?? "", "openai");
    const providerSuggestions = createProviderSuggestions(providerInput, config.providerConfigs);
    const serviceTierSelect = createEnumSelect(
      ALL_SERVICE_TIERS,
      config.serviceTier,
      "Default",
    );
    const reasoningEffortSelect = createEnumSelect(
      collectReasoningEfforts(findModelById(models, config.model ?? "")),
      config.modelReasoningEffort,
      "Model default",
    );
    const reasoningSummarySelect = createEnumSelect(
      ALL_REASONING_SUMMARIES,
      config.modelReasoningSummary,
      "Default",
    );
    const verbositySelect = createEnumSelect(
      ALL_VERBOSITIES,
      config.modelVerbosity,
      "Default",
    );

    appendField(
      defaultsGrid,
      "Model",
      modelSelect,
    );
    appendField(
      defaultsGrid,
      "Model provider",
      providerInput,
    );
    if (providerSuggestions) {
      defaultsGrid.appendChild(providerSuggestions);
    }
    appendField(
      defaultsGrid,
      "Review model",
      reviewModelSelect,
    );

    defaultsSection.content.append(defaultsGrid);

    const executionSection = createFormCard(
      "Reasoning & output",
    );
    const executionGrid = document.createElement("div");
    executionGrid.dataset.picodexModelConfigGrid = "true";
    executionGrid.dataset.layout = "execution";
    appendField(
      executionGrid,
      "Service tier",
      serviceTierSelect,
    );
    appendField(
      executionGrid,
      "Reasoning effort",
      reasoningEffortSelect,
    );
    appendField(
      executionGrid,
      "Reasoning summary",
      reasoningSummarySelect,
    );
    appendField(
      executionGrid,
      "Verbosity",
      verbositySelect,
    );
    executionSection.content.appendChild(executionGrid);

    const providerSection = createFormCard(
      "Provider",
    );
    const providerGrid = document.createElement("div");
    providerGrid.dataset.picodexModelConfigGrid = "true";
    providerGrid.dataset.layout = "provider";
    const providerEditorIdInput = createTextInput(config.modelProvider ?? "", "ai");
    const providerEditorSuggestions = createProviderSuggestions(
      providerEditorIdInput,
      config.providerConfigs,
    );
    const providerNameInput = createTextInput("", "AI Proxy");
    const providerBaseUrlInput = createTextInput("", "https://example.com/v1");
    const providerEnvKeyInput = createTextInput("", "OPENAI_API_KEY");
    const providerWireApiInput = createTextInput("", "responses");
    const providerSupportsWebsocketsSelect = createOptionalBooleanSelect(
      null,
      "Auto",
      "Enabled",
      "Disabled",
    );

    appendField(
      providerGrid,
      "Provider ID",
      providerEditorIdInput,
    );
    if (providerEditorSuggestions) {
      providerGrid.appendChild(providerEditorSuggestions);
    }
    appendField(providerGrid, "Name", providerNameInput);
    appendField(providerGrid, "Base URL", providerBaseUrlInput);
    appendField(
      providerGrid,
      "Env key",
      providerEnvKeyInput,
    );
    appendField(
      providerGrid,
      "Wire API",
      providerWireApiInput,
    );
    appendField(
      providerGrid,
      "WebSockets",
      providerSupportsWebsocketsSelect,
    );

    providerSection.content.append(providerGrid);

    const advancedSection = createCollapsibleSection("Advanced");
    const advancedGrid = document.createElement("div");
    advancedGrid.dataset.picodexModelConfigGrid = "true";
    advancedGrid.dataset.layout = "compact";

    const contextWindowInput = createNumberInput(config.modelContextWindow);
    const autoCompactInput = createNumberInput(config.modelAutoCompactTokenLimit);
    const profileInput = createTextInput(config.profile ?? "", "coding");

    appendField(
      advancedGrid,
      "Context window",
      contextWindowInput,
    );
    appendField(
      advancedGrid,
      "Auto-compact limit",
      autoCompactInput,
    );
    appendField(
      advancedGrid,
      "Active profile",
      profileInput,
    );

    advancedSection.append(advancedGrid);

    const profilesSection = createCollapsibleSection("Profiles JSON");
    const profilesTextarea = document.createElement("textarea");
    profilesTextarea.dataset.picodexModelConfigTextarea = "true";
    profilesTextarea.rows = 6;
    profilesTextarea.spellcheck = false;
    profilesTextarea.value = config.profilesJson;
    appendField(
      profilesSection,
      "profiles",
      profilesTextarea,
    );

    const footer = document.createElement("div");
    footer.dataset.picodexModelConfigFooter = "true";

    const saveStatus = document.createElement("p");
    saveStatus.dataset.picodexModelConfigStatus = "true";
    saveStatus.dataset.tone = saveStatusState.tone ?? "neutral";
    saveStatus.textContent = saveStatusState.message;

    const actions = document.createElement("div");
    actions.dataset.picodexModelConfigActions = "true";

    const cancelButton = createActionButton("Cancel", () => {
      closeModelConfig();
    });
    cancelButton.dataset.variant = "ghost";

    const saveButton = createActionButton("Save", () => {
      void handleSave();
    });
    saveButton.dataset.variant = "primary";

    actions.append(cancelButton, saveButton);
    footer.append(saveStatus, actions);

    body.addEventListener("submit", (event) => {
      event.preventDefault();
      void handleSave();
    });

    const providerDrafts = new Map(
      config.providerConfigs.map((provider) => [normalizeLabel(provider.id), { ...provider }]),
    );
    let providerEditorLoadedKey = "";
    let lastActiveProviderId = normalizeOptionalString(providerInput.value);

    modelSelect.addEventListener("change", () => {
      syncModelMeta();
    });
    reviewModelSelect.addEventListener("change", () => {
      syncSummaryPanel();
    });
    providerInput.addEventListener("input", () => {
      syncModelMeta();
    });
    providerInput.addEventListener("change", () => {
      const nextActiveProviderId = normalizeOptionalString(providerInput.value);
      if (
        normalizeLabel(providerEditorIdInput.value) === normalizeLabel(lastActiveProviderId)
      ) {
        providerEditorIdInput.value = nextActiveProviderId ?? "";
        syncProviderEditor(true);
      }
      lastActiveProviderId = nextActiveProviderId;
      syncModelMeta();
    });
    providerEditorIdInput.addEventListener("input", () => {
      syncProviderEditor(false);
    });
    providerEditorIdInput.addEventListener("change", () => {
      syncProviderEditor(true);
    });
    providerNameInput.addEventListener("input", () => {
      persistProviderEditorDraft(false);
      syncProviderEditorMeta();
    });
    providerBaseUrlInput.addEventListener("input", () => {
      persistProviderEditorDraft(false);
      syncProviderEditorMeta();
    });
    providerEnvKeyInput.addEventListener("input", () => {
      persistProviderEditorDraft(false);
      syncProviderEditorMeta();
    });
    providerWireApiInput.addEventListener("input", () => {
      persistProviderEditorDraft(false);
      syncProviderEditorMeta();
    });
    providerSupportsWebsocketsSelect.addEventListener("change", () => {
      persistProviderEditorDraft(false);
      syncProviderEditorMeta();
    });
    serviceTierSelect.addEventListener("change", () => {
      syncSummaryPanel();
    });
    reasoningEffortSelect.addEventListener("change", () => {
      syncSummaryPanel();
    });
    reasoningSummarySelect.addEventListener("change", () => {
      syncSummaryPanel();
    });
    verbositySelect.addEventListener("change", () => {
      syncSummaryPanel();
    });

    syncModelMeta();
    syncProviderEditor(true);
    syncSummaryPanel();

    async function handleSave(): Promise<void> {
      try {
        persistProviderEditorDraft(true);
        saveButton.disabled = true;
        cancelButton.disabled = true;
        modelSelect.disabled = true;
        reviewModelSelect.disabled = true;
        providerInput.disabled = true;
        providerEditorIdInput.disabled = true;
        providerNameInput.disabled = true;
        providerBaseUrlInput.disabled = true;
        providerEnvKeyInput.disabled = true;
        providerWireApiInput.disabled = true;
        providerSupportsWebsocketsSelect.disabled = true;
        serviceTierSelect.disabled = true;
        reasoningEffortSelect.disabled = true;
        reasoningSummarySelect.disabled = true;
        verbositySelect.disabled = true;
        contextWindowInput.disabled = true;
        autoCompactInput.disabled = true;
        profileInput.disabled = true;
        profilesTextarea.disabled = true;
        saveStatus.dataset.tone = "neutral";
        saveStatus.textContent = "Saving model configuration...";

        const profilesValue = parseProfilesJson(profilesTextarea.value);
        const modelProvidersValue = serializeProviderConfigsForSave(providerDrafts);
        const edits = [
          createConfigEdit("model", normalizeOptionalString(modelSelect.value)),
          createConfigEdit("review_model", normalizeOptionalString(reviewModelSelect.value)),
          createConfigEdit("model_provider", normalizeOptionalString(providerInput.value)),
          createConfigEdit("model_providers", modelProvidersValue),
          createConfigEdit("service_tier", normalizeOptionalString(serviceTierSelect.value)),
          createConfigEdit(
            "model_reasoning_effort",
            normalizeOptionalString(reasoningEffortSelect.value),
          ),
          createConfigEdit(
            "model_reasoning_summary",
            normalizeOptionalString(reasoningSummarySelect.value),
          ),
          createConfigEdit("model_verbosity", normalizeOptionalString(verbositySelect.value)),
          createConfigEdit(
            "model_context_window",
            parseOptionalInteger(contextWindowInput.value, "Context window"),
          ),
          createConfigEdit(
            "model_auto_compact_token_limit",
            parseOptionalInteger(autoCompactInput.value, "Auto-compact limit"),
          ),
          createConfigEdit("profile", normalizeOptionalString(profileInput.value)),
          createConfigEdit("profiles", profilesValue),
        ];

        const result = await callAppServerRequest("config/batchWrite", {
          edits,
          expectedVersion: config.userConfigVersion,
          reloadUserConfig: true,
        });
        const { config: freshConfig, models: freshModels } = await loadModelConfigData();
        const version = extractWriteVersion(result);
        freshConfig.userConfigVersion = version ?? freshConfig.userConfigVersion;
        syncVisibleModelButtonLabels(freshConfig, freshModels, anchor);
        showNotice("Model configuration saved.");
        renderModelConfigPanel(panel, anchor, freshConfig, freshModels, {
          message: "Saved and refreshed.",
          tone: "success",
        });
        positionPanel(panel, anchor);
        refreshModelButtons(document);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to save model configuration.";
        saveStatus.dataset.tone = "error";
        saveStatus.textContent = message;
        showNotice(message);
      } finally {
        saveButton.disabled = false;
        cancelButton.disabled = false;
        modelSelect.disabled = false;
        reviewModelSelect.disabled = false;
        providerInput.disabled = false;
        providerEditorIdInput.disabled = false;
        providerNameInput.disabled = false;
        providerBaseUrlInput.disabled = false;
        providerEnvKeyInput.disabled = false;
        providerWireApiInput.disabled = false;
        providerSupportsWebsocketsSelect.disabled = false;
        serviceTierSelect.disabled = false;
        reasoningEffortSelect.disabled = false;
        reasoningSummarySelect.disabled = false;
        verbositySelect.disabled = false;
        contextWindowInput.disabled = false;
        autoCompactInput.disabled = false;
        profileInput.disabled = false;
        profilesTextarea.disabled = false;
      }
    }

    function syncModelMeta(): void {
      const selectedModel = findModelById(models, modelSelect.value);
      syncReasoningEffortOptions(
        reasoningEffortSelect,
        selectedModel,
        config.modelReasoningEffort,
      );
      const providerDescription = describeProviderValue(
        normalizeOptionalString(providerInput.value),
        config.providerConfigs,
      );
      void providerDescription;
      void selectedModel;
      syncSummaryPanel();
    }

    function syncProviderEditor(forceLoad: boolean): void {
      const editorProviderId = normalizeOptionalString(providerEditorIdInput.value);
      const nextKey = normalizeLabel(editorProviderId);
      const existing = editorProviderId ? providerDrafts.get(nextKey) ?? null : null;
      if (existing && (forceLoad || nextKey !== providerEditorLoadedKey)) {
        providerNameInput.value = existing.name ?? "";
        providerBaseUrlInput.value = existing.baseUrl ?? "";
        providerEnvKeyInput.value = existing.envKey ?? "";
        providerWireApiInput.value = existing.wireApi ?? "";
        providerSupportsWebsocketsSelect.value = stringifyOptionalBoolean(existing.supportsWebsockets);
        providerEditorLoadedKey = nextKey;
      } else if (!existing && forceLoad) {
        providerNameInput.value = "";
        providerBaseUrlInput.value = "";
        providerEnvKeyInput.value = "";
        providerWireApiInput.value = "";
        providerSupportsWebsocketsSelect.value = "";
        providerEditorLoadedKey = nextKey;
      }

      syncProviderEditorMeta();
      syncSummaryPanel();
    }

    function persistProviderEditorDraft(validate: boolean): void {
      const providerId = normalizeOptionalString(providerEditorIdInput.value);
      if (!providerId) {
        return;
      }

      const draft = readProviderDraft(providerId);
      if (validate && !draft.name && hasProviderDraftExtraSettings(draft)) {
        throw new Error(`Provider "${providerId}" needs a name.`);
      }

      if (!draft.name && !hasProviderDraftExtraSettings(draft)) {
        providerDrafts.delete(normalizeLabel(providerId));
        return;
      }

      providerDrafts.set(normalizeLabel(providerId), draft);
      providerEditorLoadedKey = normalizeLabel(providerId);
    }

    function syncProviderEditorMeta(): void {
      const providerId = normalizeOptionalString(providerEditorIdInput.value);
      if (!providerId) {
        syncSummaryPanel();
        return;
      }

      const existing = providerDrafts.get(normalizeLabel(providerId)) ?? null;
      const providerSummary = [
        existing?.name ? `Name: ${existing.name}.` : "",
        existing?.baseUrl ? `Base URL: ${existing.baseUrl}.` : "",
        existing?.envKey ? `Env key: ${existing.envKey}.` : "",
        existing?.wireApi ? `Wire API: ${existing.wireApi}.` : "",
      ]
        .filter((value) => value.length > 0)
        .join(" ");
      void providerSummary;
      syncSummaryPanel();
    }

    function readProviderDraft(providerId: string): ProviderConfig {
      return {
        id: providerId,
        name: normalizeOptionalString(providerNameInput.value),
        baseUrl: normalizeOptionalString(providerBaseUrlInput.value),
        envKey: normalizeOptionalString(providerEnvKeyInput.value),
        wireApi: normalizeOptionalString(providerWireApiInput.value),
        supportsWebsockets: parseOptionalBoolean(providerSupportsWebsocketsSelect.value),
      };
    }

    function syncSummaryPanel(): void {
      const selectedModel = findModelById(models, modelSelect.value);
      const providerId = normalizeOptionalString(providerInput.value);
      const providerDraft = providerId ? providerDrafts.get(normalizeLabel(providerId)) ?? null : null;
      const reviewModel = findModelById(models, reviewModelSelect.value);
      summaryTitle.textContent = selectedModel?.displayName ?? "App default";

      summaryBadges.replaceChildren(
        createBadge(providerId ? `provider:${providerId}` : "provider:auto"),
        createBadge(serviceTierSelect.value ? `tier:${serviceTierSelect.value}` : "tier:auto"),
        createBadge(
          reasoningEffortSelect.value ? `effort:${reasoningEffortSelect.value}` : "effort:model",
        ),
      );

      summaryFacts.replaceChildren(
        createFactRow("Review model", reviewModel?.displayName ?? "Follow main model"),
        createFactRow("Provider name", providerDraft?.name ?? config.modelProviderName ?? "Unset"),
        createFactRow("Base URL", providerDraft?.baseUrl ?? "Built-in or unset"),
      );
    }

    main.append(
      defaultsSection.card,
      executionSection.card,
      providerSection.card,
      advancedSection,
      profilesSection,
    );
    if (providerSuggestions) {
      body.appendChild(providerSuggestions);
    }
    if (providerEditorSuggestions) {
      body.appendChild(providerEditorSuggestions);
    }
    shell.append(sidebar, main);
    body.append(shell, footer);
    panel.replaceChildren(header, body);
  }

  function createSection(titleText: string): HTMLElement {
    const section = document.createElement("section");
    section.dataset.picodexModelConfigSection = "true";
    const title = document.createElement("h3");
    title.textContent = titleText;
    section.appendChild(title);
    return section;
  }

  function createFormCard(
    titleText: string,
    descriptionText = "",
  ): {
    card: HTMLElement;
    content: HTMLDivElement;
  } {
    const card = document.createElement("section");
    card.dataset.picodexModelConfigCard = "true";

    const header = document.createElement("div");
    header.dataset.picodexModelConfigCardHeader = "true";
    const titleWrap = document.createElement("div");
    titleWrap.dataset.picodexModelConfigCardTitle = "true";
    const title = document.createElement("strong");
    title.textContent = titleText;
    titleWrap.appendChild(title);
    if (descriptionText.trim().length > 0) {
      const description = document.createElement("p");
      description.textContent = descriptionText;
      titleWrap.appendChild(description);
    }
    header.appendChild(titleWrap);

    const content = document.createElement("div");
    content.dataset.picodexModelConfigCardContent = "true";

    card.append(header, content);
    return { card, content };
  }

  function createCollapsibleSection(titleText: string): HTMLDetailsElement {
    const details = document.createElement("details");
    details.dataset.picodexModelConfigDisclosure = "true";

    const summary = document.createElement("summary");
    summary.dataset.picodexModelConfigDisclosureSummary = "true";
    summary.textContent = titleText;

    details.appendChild(summary);
    return details;
  }

  function createBadge(text: string): HTMLElement {
    const badge = document.createElement("span");
    badge.dataset.picodexModelConfigBadge = "true";
    badge.textContent = text;
    return badge;
  }

  function createFactRow(labelText: string, valueText: string): HTMLElement {
    const row = document.createElement("div");
    row.dataset.picodexModelConfigFact = "true";
    const label = document.createElement("span");
    label.dataset.picodexModelConfigFactLabel = "true";
    label.textContent = labelText;
    const value = document.createElement("strong");
    value.dataset.picodexModelConfigFactValue = "true";
    value.textContent = valueText;
    row.append(label, value);
    return row;
  }

  function appendField(
    container: HTMLElement,
    labelText: string,
    control: HTMLElement,
    hintText?: string,
  ): void {
    const field = document.createElement("label");
    field.dataset.picodexModelConfigField = "true";

    const label = document.createElement("span");
    label.dataset.picodexModelConfigFieldLabel = "true";
    label.textContent = labelText;

    field.append(label, control);
    if (hintText) {
      const hint = document.createElement("small");
      hint.dataset.picodexModelConfigFieldHint = "true";
      hint.textContent = hintText;
      field.appendChild(hint);
    }
    container.appendChild(field);
  }

  function createTextInput(value: string, placeholder: string): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.dataset.picodexModelConfigInput = "true";
    input.autocomplete = "off";
    input.spellcheck = false;
    return input;
  }

  function createProviderSuggestions(
    input: HTMLInputElement,
    options: ProviderConfig[],
  ): HTMLDataListElement | null {
    if (options.length === 0) {
      return null;
    }

    const listId = `picodex-model-provider-options-${Math.random().toString(36).slice(2, 10)}`;
    const datalist = document.createElement("datalist");
    datalist.id = listId;
    for (const option of options) {
      const element = document.createElement("option");
      element.value = option.id;
      element.label = option.name ? `${option.id} (${option.name})` : option.id;
      datalist.appendChild(element);
    }

    input.setAttribute("list", listId);
    return datalist;
  }

  function createNumberInput(value: number | null): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.value = value === null ? "" : String(value);
    input.placeholder = "Unset";
    input.dataset.picodexModelConfigInput = "true";
    input.inputMode = "numeric";
    return input;
  }

  function createOptionalBooleanSelect(
    selectedValue: boolean | null,
    emptyLabel: string,
    trueLabel: string,
    falseLabel: string,
  ): HTMLSelectElement {
    const select = document.createElement("select");
    select.dataset.picodexModelConfigInput = "true";

    for (const option of [
      { value: "", label: emptyLabel },
      { value: "true", label: trueLabel },
      { value: "false", label: falseLabel },
    ]) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }

    select.value = stringifyOptionalBoolean(selectedValue);
    return select;
  }

  function createEnumSelect<T extends string>(
    values: T[],
    selectedValue: T | null,
    emptyLabel: string,
  ): HTMLSelectElement {
    return createSelectControl(
      values.map((value) => ({
        value,
        label: value,
      })),
      selectedValue,
      emptyLabel,
    );
  }

  function createSelectControl(
    options: Array<{ value: string; label: string }>,
    selectedValue: string | null,
    emptyLabel: string,
  ): HTMLSelectElement {
    const select = document.createElement("select");
    select.dataset.picodexModelConfigInput = "true";

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = emptyLabel;
    select.appendChild(emptyOption);

    for (const option of options) {
      const optionElement = document.createElement("option");
      optionElement.value = option.value;
      optionElement.textContent = option.label;
      select.appendChild(optionElement);
    }

    select.value = selectedValue ?? "";
    return select;
  }

  function syncReasoningEffortOptions(
    select: HTMLSelectElement,
    model: ModelOption | null,
    preferredValue: string | null,
  ): void {
    const currentValue = normalizeOptionalString(select.value) ?? preferredValue;
    const supportedValues = collectReasoningEfforts(model);
    const values = currentValue && !supportedValues.includes(currentValue as ModelReasoningEffort)
      ? [currentValue as ModelReasoningEffort, ...supportedValues]
      : supportedValues;

    select.replaceChildren();

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = model?.defaultReasoningEffort
      ? `Model default (${model.defaultReasoningEffort})`
      : "Model default";
    select.appendChild(emptyOption);

    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }

    select.value = currentValue ?? "";
  }

  function createActionButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.picodexModelConfigButton = "true";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function positionPanel(panel: HTMLDivElement, anchor: HTMLElement): void {
    void anchor;
    const panelWidth = Math.max(360, Math.min(860, window.innerWidth - 32));

    panel.style.width = `${panelWidth}px`;
    panel.style.maxHeight = `${Math.max(320, window.innerHeight - 32)}px`;

    const panelRect = panel.getBoundingClientRect();
    const left = Math.max(16, Math.round((window.innerWidth - panelRect.width) / 2));
    const top = Math.max(16, Math.round((window.innerHeight - panelRect.height) / 2));

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  async function callAppServerRequest(method: string, params?: unknown): Promise<unknown> {
    return callPicodexIpc("app-server/request", {
      method,
      params,
    });
  }

  async function loadModelConfigData(): Promise<{
    config: ConfigSnapshot;
    models: ModelOption[];
  }> {
    const [configResponse, modelListResponse] = await Promise.all([
      callAppServerRequest("config/read", {
        includeLayers: false,
      }),
      callAppServerRequest("model/list", {
        includeHidden: false,
        limit: 100,
      }),
    ]);

    const config = extractConfigSnapshot(configResponse);
    const models = extractModels(modelListResponse);
    knownModels = models;
    currentConfiguredModelLabel = deriveConfiguredModelLabel(config, models);
    return { config, models };
  }

  function extractConfigSnapshot(result: unknown): ConfigSnapshot {
    const response = isRecord(result) ? result : {};
    const config = isRecord(response.config) ? response.config : {};
    const userLayerMetadata = extractUserLayerMetadata(response.origins);
    const modelProvider = normalizeOptionalString(config.model_provider);
    return {
      model: normalizeOptionalString(config.model),
      reviewModel: normalizeOptionalString(config.review_model),
      modelProvider,
      modelProviderName: extractModelProviderName(config, modelProvider),
      modelContextWindow: normalizeOptionalNumber(config.model_context_window),
      modelAutoCompactTokenLimit: normalizeOptionalNumber(config.model_auto_compact_token_limit),
      serviceTier: normalizeEnum<ModelServiceTier>(config.service_tier, ALL_SERVICE_TIERS),
      modelReasoningEffort: normalizeOptionalString(config.model_reasoning_effort),
      modelReasoningSummary: normalizeEnum<ModelReasoningSummary>(
        config.model_reasoning_summary,
        ALL_REASONING_SUMMARIES,
      ),
      modelVerbosity: normalizeEnum<ModelVerbosity>(config.model_verbosity, ALL_VERBOSITIES),
      profile: normalizeOptionalString(config.profile),
      profilesJson: stringifyProfiles(config.profiles),
      providerConfigs: extractProviderConfigs(config),
      userConfigPath: userLayerMetadata?.filePath ?? null,
      userConfigVersion: userLayerMetadata?.version ?? null,
    };
  }

  function extractUserLayerMetadata(
    origins: unknown,
  ): { version: string | null; filePath: string | null } | null {
    if (!isRecord(origins)) {
      return null;
    }

    for (const value of Object.values(origins)) {
      if (!isRecord(value) || !isRecord(value.name)) {
        continue;
      }

      if (value.name.type !== "user") {
        continue;
      }

      return {
        version: typeof value.version === "string" ? value.version : null,
        filePath: typeof value.name.file === "string" ? value.name.file : null,
      };
    }

    return null;
  }

  function stringifyProfiles(value: unknown): string {
    if (!isRecord(value) || Object.keys(value).length === 0) {
      return "";
    }

    return JSON.stringify(value, null, 2);
  }

  function extractModelProviderName(config: Record<string, unknown>, providerId: string | null): string | null {
    if (!providerId) {
      return null;
    }

    const providers = isRecord(config.model_providers) ? config.model_providers : null;
    const provider = providers && isRecord(providers[providerId]) ? providers[providerId] : null;
    return provider && typeof provider.name === "string" && provider.name.trim().length > 0
      ? provider.name.trim()
      : null;
  }

  function extractProviderConfigs(config: Record<string, unknown>): ProviderConfig[] {
    const providers = isRecord(config.model_providers) ? config.model_providers : null;
    if (!providers) {
      return [];
    }

    return Object.entries(providers)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([id, provider]) => ({
        id,
        name: typeof provider.name === "string" && provider.name.trim().length > 0
          ? provider.name.trim()
          : null,
        baseUrl: typeof provider.base_url === "string" && provider.base_url.trim().length > 0
          ? provider.base_url.trim()
          : null,
        envKey: typeof provider.env_key === "string" && provider.env_key.trim().length > 0
          ? provider.env_key.trim()
          : null,
        wireApi: typeof provider.wire_api === "string" && provider.wire_api.trim().length > 0
          ? provider.wire_api.trim()
          : null,
        supportsWebsockets: typeof provider.supports_websockets === "boolean"
          ? provider.supports_websockets
          : null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  function describeProviderValue(
    providerId: string | null,
    options: ProviderConfig[],
  ): string {
    if (!providerId) {
      return "";
    }

    const selected = options.find((option) => option.id === providerId) ?? null;
    if (!selected) {
      return `Provider: ${providerId}.`;
    }

    return selected.name
      ? `Provider: ${selected.id} (${selected.name}).`
      : `Provider: ${selected.id}.`;
  }

  function findProviderConfigById(
    providers: ProviderConfig[],
    providerId: string,
  ): ProviderConfig | null {
    const normalizedId = normalizeLabel(providerId);
    if (!normalizedId) {
      return null;
    }

    return providers.find((provider) => normalizeLabel(provider.id) === normalizedId) ?? null;
  }

  function hasProviderDraftExtraSettings(provider: ProviderConfig): boolean {
    return (
      provider.baseUrl !== null ||
      provider.envKey !== null ||
      provider.wireApi !== null ||
      provider.supportsWebsockets !== null
    );
  }

  function serializeProviderConfigsForSave(
    providers: Map<string, ProviderConfig>,
  ): Record<string, unknown> | null {
    const entries = Array.from(providers.values())
      .filter((provider) => provider.name !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (entries.length === 0) {
      return null;
    }

    return Object.fromEntries(
      entries.map((provider) => [
        provider.id,
        {
          name: provider.name,
          ...(provider.baseUrl ? { base_url: provider.baseUrl } : {}),
          ...(provider.envKey ? { env_key: provider.envKey } : {}),
          ...(provider.wireApi ? { wire_api: provider.wireApi } : {}),
          ...(provider.supportsWebsockets !== null
            ? { supports_websockets: provider.supportsWebsockets }
            : {}),
        },
      ]),
    );
  }

  function extractModels(result: unknown): ModelOption[] {
    if (!isRecord(result) || !Array.isArray(result.data)) {
      return [];
    }

    return result.data
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        id: normalizeOptionalString(entry.id) ?? "",
        model: normalizeOptionalString(entry.model) ?? "",
        displayName:
          normalizeOptionalString(entry.displayName) ??
          normalizeOptionalString(entry.display_name) ??
          normalizeOptionalString(entry.model) ??
          normalizeOptionalString(entry.id) ??
          "",
        description: normalizeOptionalString(entry.description) ?? "",
        defaultReasoningEffort:
          normalizeOptionalString(entry.defaultReasoningEffort) ??
          normalizeOptionalString(entry.default_reasoning_effort),
        supportedReasoningEfforts: Array.isArray(entry.supportedReasoningEfforts)
          ? entry.supportedReasoningEfforts
              .filter((value): value is Record<string, unknown> => isRecord(value))
              .map((value) => ({
                effort:
                  normalizeOptionalString(value.reasoningEffort) ??
                  normalizeOptionalString(value.reasoning_effort) ??
                  "medium",
                description: normalizeOptionalString(value.description) ?? "",
              }))
          : Array.isArray(entry.supported_reasoning_efforts)
            ? entry.supported_reasoning_efforts
              .filter((value): value is Record<string, unknown> => isRecord(value))
              .map((value) => ({
                effort: normalizeOptionalString(value.reasoning_effort) ?? "medium",
                description: normalizeOptionalString(value.description) ?? "",
              }))
            : [],
      }))
      .filter((entry) => entry.id.length > 0);
  }

  function extractWriteVersion(result: unknown): string | null {
    return isRecord(result) && typeof result.version === "string" ? result.version : null;
  }

  function collectReasoningEfforts(model: ModelOption | null): ModelReasoningEffort[] {
    const direct = model?.supportedReasoningEfforts.map((entry) => entry.effort) ?? [];
    if (direct.length > 0) {
      return direct;
    }

    const seen = new Set<string>();
    for (const knownModel of knownModels) {
      for (const effort of knownModel.supportedReasoningEfforts.map((entry) => entry.effort)) {
        seen.add(effort);
      }
    }

    return Array.from(seen);
  }

  function deriveConfiguredModelLabel(config: ConfigSnapshot, models: ModelOption[]): string | null {
    const configuredModel = normalizeOptionalString(config.model);
    if (!configuredModel) {
      return null;
    }

    return findModelById(models, configuredModel)?.displayName ?? configuredModel;
  }

  function syncVisibleModelButtonLabels(
    config: ConfigSnapshot,
    models: ModelOption[],
    anchor: HTMLElement,
  ): void {
    const nextLabel = deriveConfiguredModelLabel(config, models);
    currentConfiguredModelLabel = nextLabel;
    if (!nextLabel) {
      return;
    }

    updateModelButtonText(anchor, nextLabel);
    document
      .querySelectorAll<HTMLElement>('[data-picodex-model-config-trigger="true"]')
      .forEach((button) => {
        updateModelButtonText(button, nextLabel);
      });
  }

  function createConfigEdit(keyPath: string, value: unknown): {
    keyPath: string;
    value: unknown;
    mergeStrategy: "replace";
  } {
    return {
      keyPath,
      value: value ?? null,
      mergeStrategy: "replace",
    };
  }

  function parseProfilesJson(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Profiles JSON must be valid JSON.");
    }

    if (!isRecord(parsed)) {
      throw new Error("Profiles JSON must be an object.");
    }

    return parsed;
  }

  function parseOptionalInteger(raw: string, label: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    const value = Number(trimmed);
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be an integer.`);
    }

    return value;
  }

  function findModelById(models: ModelOption[], modelId: string): ModelOption | null {
    const normalizedId = normalizeLabel(modelId);
    if (!normalizedId) {
      return null;
    }

    return models.find((model) => normalizedModelLabels(model).has(normalizedId)) ?? null;
  }

  function updateModelButtonText(button: HTMLElement, nextLabel: string): void {
    const normalizedNextLabel = nextLabel.trim();
    if (!normalizedNextLabel) {
      return;
    }

    if (button.childElementCount === 0) {
      if ((button.textContent ?? "").trim() !== normalizedNextLabel) {
        button.textContent = normalizedNextLabel;
      }
      return;
    }

    const textNodeWalker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    let textNode: Node | null = textNodeWalker.nextNode();
    while (textNode && (textNode.textContent ?? "").trim().length === 0) {
      textNode = textNodeWalker.nextNode();
    }
    if (textNode) {
      if ((textNode.textContent ?? "").trim() !== normalizedNextLabel) {
        textNode.textContent = normalizedNextLabel;
      }
      return;
    }

    const leaf = Array.from(button.querySelectorAll<HTMLElement>("*")).find(
      (child) => child.childElementCount === 0 && (child.textContent ?? "").trim().length > 0,
    );
    if (leaf) {
      if ((leaf.textContent ?? "").trim() !== normalizedNextLabel) {
        leaf.textContent = normalizedNextLabel;
      }
      return;
    }

    if ((button.textContent ?? "").trim() !== normalizedNextLabel) {
      button.textContent = normalizedNextLabel;
    }
  }

  function buttonAlreadyDisplaysModelLabel(button: HTMLElement, expectedLabel: string): boolean {
    const normalizedExpectedLabel = normalizeLabel(expectedLabel);
    if (!normalizedExpectedLabel) {
      return true;
    }

    const textContent = normalizeLabel(button.textContent);
    if (textContent === normalizedExpectedLabel) {
      return true;
    }

    return Array.from(button.querySelectorAll<HTMLElement>("*")).some(
      (child) =>
        child.childElementCount === 0 && normalizeLabel(child.textContent) === normalizedExpectedLabel,
    );
  }

  function normalizeOptionalString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function normalizeOptionalNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function normalizeEnum<T extends string>(value: unknown, values: readonly T[]): T | null {
    return typeof value === "string" && values.includes(value as T) ? (value as T) : null;
  }

  function parseOptionalBoolean(value: string): boolean | null {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return null;
  }

  function stringifyOptionalBoolean(value: boolean | null): string {
    if (value === true) {
      return "true";
    }
    if (value === false) {
      return "false";
    }
    return "";
  }

  function normalizeLabel(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  return {
    startModelConfigObserver,
    openModelConfigFromShortcut,
  };
}
