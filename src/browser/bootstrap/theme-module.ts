export function installBootstrapThemeModule(args: {
  appearanceThemeValues: Set<string>;
  parseHostFetchBody: (value: unknown) => Record<string, unknown>;
}): {
  installPocodexSystemThemeListener: () => void;
  applyPocodexThemePreference: (preference: "light" | "dark" | "system") => void;
  syncPocodexThemeFromPersistedAtomState: (state: Record<string, unknown>) => void;
  syncPocodexThemeFromPersistedAtomUpdate: (key: unknown, value: unknown) => void;
  observePocodexThemeHostFetch: (message: Record<string, unknown>) => void;
  observePocodexThemeHostFetchResponse: (message: Record<string, unknown>) => void;
} {
  const { appearanceThemeValues, parseHostFetchBody } = args;
  const pendingAppearanceThemeFetchRequestIds = new Set<string>();
  let pocodexThemePreference: "light" | "dark" | "system" = "system";

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

  function resolvePocodexThemeVariant(
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
    if (!appearanceThemeValues.has(normalizedValue)) {
      return null;
    }

    return normalizedValue as "light" | "dark" | "system";
  }

  return {
    installPocodexSystemThemeListener,
    applyPocodexThemePreference,
    syncPocodexThemeFromPersistedAtomState,
    syncPocodexThemeFromPersistedAtomUpdate,
    observePocodexThemeHostFetch,
    observePocodexThemeHostFetchResponse,
  };
}
