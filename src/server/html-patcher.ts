import { createHash } from "node:crypto";

export function patchIndexHtml(
  html: string,
  options: {
    bootstrapScript: string;
    fontPreloadHref?: string;
    stylesheetHref: string;
  },
): string {
  const fontPreloadTag = options.fontPreloadHref
    ? `<link rel="preload" href="${options.fontPreloadHref}" as="font" type="font/woff2" crossorigin>`
    : "";
  const stylesheetTag = `<link rel="stylesheet" href="${options.stylesheetHref}" id="picodex-stylesheet">`;
  const bootstrapTag = `<script>${options.bootstrapScript}</script>`;
  const withBootstrap = html.replace(
    /(\s*)(<script type="module"\s+crossorigin\s+src="\.[^"]+"><\/script>)/,
    (_match, indentation, entryScript) =>
      renderInjectedBootstrapTags(indentation, entryScript, {
        fontPreloadTag,
        stylesheetTag,
        bootstrapTag,
      }),
  );

  if (withBootstrap === html) {
    throw new Error("Unable to locate the Codex entry script in index.html");
  }

  const hash = createHash("sha256").update(options.bootstrapScript).digest("base64");
  const encodedHash = `&#39;sha256-${hash}&#39;`;
  const withCsp = withBootstrap.includes("script-src &#39;self&#39;")
    ? withBootstrap.replace("script-src &#39;self&#39;", `script-src ${encodedHash} &#39;self&#39;`)
    : withBootstrap.replace(/script-src\s+'self'/, `script-src '${`sha256-${hash}`}' 'self'`);

  if (withCsp === withBootstrap) {
    throw new Error("Unable to update the Codex content security policy");
  }

  return withCsp;
}

function renderInjectedBootstrapTags(
  indentation: string,
  entryScript: string,
  tags: {
    fontPreloadTag: string;
    stylesheetTag: string;
    bootstrapTag: string;
  },
): string {
  const injectedTags = [
    tags.fontPreloadTag ? `${indentation}${tags.fontPreloadTag}` : null,
    `${indentation}${tags.stylesheetTag}`,
    `${indentation}${tags.bootstrapTag}`,
    `${indentation}${entryScript}`,
  ].filter((line): line is string => line !== null);

  return injectedTags.join("\n");
}
