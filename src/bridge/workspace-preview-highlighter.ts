import { bundledLanguagesInfo, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";

const SHIKI_LIGHT_THEME = "github-light-high-contrast";
const SHIKI_DARK_THEME = "github-dark-high-contrast";

const languageAliases = new Map<string, BundledLanguage>();

for (const language of bundledLanguagesInfo) {
  const canonicalLanguage = language.id as BundledLanguage;
  languageAliases.set(language.id, canonicalLanguage);
  for (const alias of language.aliases ?? []) {
    languageAliases.set(alias, canonicalLanguage);
  }
}

let workspacePreviewHighlighterPromise: Promise<Highlighter> | null = null;

function getWorkspacePreviewHighlighter(): Promise<Highlighter> {
  if (!workspacePreviewHighlighterPromise) {
    workspacePreviewHighlighterPromise = createHighlighter({
      themes: [SHIKI_LIGHT_THEME, SHIKI_DARK_THEME],
      langs: [],
    });
  }

  return workspacePreviewHighlighterPromise;
}

function resolveWorkspacePreviewLanguage(language: string): BundledLanguage | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return languageAliases.get(normalized) ?? null;
}

export async function highlightWorkspacePreviewCode(args: {
  code: string;
  language?: string;
  themeVariant?: string;
}): Promise<{ html: string; language: string }> {
  const { code, language = "", themeVariant = "dark" } = args;
  const resolvedLanguage = resolveWorkspacePreviewLanguage(language);
  if (!resolvedLanguage) {
    return { html: "", language: "" };
  }

  const highlighter = await getWorkspacePreviewHighlighter();
  await highlighter.loadLanguage(resolvedLanguage);
  const resolvedTheme = themeVariant === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;

  return {
    html: highlighter.codeToHtml(code, {
      lang: resolvedLanguage,
      theme: resolvedTheme,
    }),
    language: resolvedLanguage,
  };
}
