export function installBootstrapThemeModule(args: {
  appearanceThemeValues: Set<string>;
  parseHostFetchBody: (value: unknown) => Record<string, unknown>;
}): {
  installPicodexSystemThemeListener: () => void;
  applyPicodexThemePreference: (preference: "light" | "dark" | "system") => void;
  syncPicodexThemeFromPersistedAtomState: (state: Record<string, unknown>) => void;
  syncPicodexThemeFromPersistedAtomUpdate: (key: unknown, value: unknown) => void;
  observePicodexThemeHostFetch: (message: Record<string, unknown>) => void;
  observePicodexThemeHostFetchResponse: (message: Record<string, unknown>) => void;
} {
  const { appearanceThemeValues, parseHostFetchBody } = args;
  const pendingAppearanceThemeFetchRequestIds = new Set<string>();
  let picodexThemePreference: "light" | "dark" | "system" = "system";

  function installPicodexSystemThemeListener(): void {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (picodexThemePreference === "system") {
        applyPicodexThemePreference("system");
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

  function applyPicodexThemePreference(preference: "light" | "dark" | "system"): void {
    picodexThemePreference = preference;
    const variant = resolvePicodexThemeVariant(preference);
    document.documentElement.dataset.picodexThemeVariant = variant;
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

  function resolvePicodexThemeVariant(
    preference: "light" | "dark" | "system",
  ): "light" | "dark" {
    if (preference === "light" || preference === "dark") {
      return preference;
    }

    if (typeof window.matchMedia !== "function") {
      return "light";
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function syncPicodexThemeFromPersistedAtomState(state: Record<string, unknown>): void {
    const preference = extractPicodexThemePreferenceFromEntries(Object.entries(state));
    if (preference) {
      applyPicodexThemePreference(preference);
    }
  }

  function syncPicodexThemeFromPersistedAtomUpdate(key: unknown, value: unknown): void {
    if (typeof key !== "string") {
      return;
    }

    const preference = extractPicodexThemePreferenceFromEntries([[key, value]]);
    if (preference) {
      applyPicodexThemePreference(preference);
    }
  }

  function syncPicodexThemeFromGlobalStateValue(value: unknown): void {
    const preference = normalizePicodexThemePreference(value);
    if (preference) {
      applyPicodexThemePreference(preference);
    }
  }

  function observePicodexThemeHostFetch(message: Record<string, unknown>): void {
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

    syncPicodexThemeFromGlobalStateValue(body.value);
  }

  function observePicodexThemeHostFetchResponse(message: Record<string, unknown>): void {
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
    syncPicodexThemeFromGlobalStateValue(body.value);
  }

  function extractPicodexThemePreferenceFromEntries(
    entries: Array<[string, unknown]>,
  ): "light" | "dark" | "system" | null {
    for (const [key, value] of entries) {
      const preference = normalizePicodexThemePreference(value);
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

  function normalizePicodexThemePreference(value: unknown): "light" | "dark" | "system" | null {
    const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!appearanceThemeValues.has(normalizedValue)) {
      return null;
    }

    return normalizedValue as "light" | "dark" | "system";
  }

  return {
    installPicodexSystemThemeListener,
    applyPicodexThemePreference,
    syncPicodexThemeFromPersistedAtomState,
    syncPicodexThemeFromPersistedAtomUpdate,
    observePicodexThemeHostFetch,
    observePicodexThemeHostFetchResponse,
  };
}
