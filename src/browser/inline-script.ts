export function serializeInlineScript<TConfig>(
  script: (config: TConfig) => void,
  config: TConfig,
): string {
  return serializeInlineScriptWithDeclarations(script, config);
}

export function serializeInlineScriptWithDeclarations<TConfig>(
  script: (config: TConfig) => void,
  config: TConfig,
  declarations: Function[] = [],
): string {
  const serializedConfig = JSON.stringify(config).replaceAll("<", "\\u003c");
  const serializedDeclarations = declarations.map((declaration) => {
    if (typeof declaration !== "function" || declaration.name.length === 0) {
      throw new Error("Inline script declarations must be named functions.");
    }
    return `const ${declaration.name} = ${declaration.toString()};`;
  });
  return [
    "(() => {",
    "  const __name = (target) => target;",
    ...serializedDeclarations.map((line) => `  ${line}`),
    `  (${script.toString()})(${serializedConfig});`,
    "})();",
  ].join("\n");
}
