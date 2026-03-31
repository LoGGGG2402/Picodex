import { serializeInlineScriptWithDeclarations } from "../inline-script.js";

import { installBootstrapBridgeModule } from "./bridge-module.js";
import { installBootstrapFilesModule } from "./files-module.js";
import { bootstrapPicodexInBrowser } from "./browser-runtime.js";
import { installBootstrapMobileSidebarModule } from "./mobile-sidebar-module.js";
import { installBootstrapOpenInAppModule } from "./open-in-app-module.js";
import { installBootstrapSettingsImportModule } from "./settings-import-module.js";
import { installBootstrapStatsigModule } from "./statsig-module.js";
import { installBootstrapThemeModule } from "./theme-module.js";

export type { BootstrapScriptConfig } from "./types.js";

export function renderBootstrapScript(
  config: import("./types.js").BootstrapScriptConfig,
): string {
  return serializeInlineScriptWithDeclarations(bootstrapPicodexInBrowser, config, [
    installBootstrapStatsigModule,
    installBootstrapThemeModule,
    installBootstrapSettingsImportModule,
    installBootstrapFilesModule,
    installBootstrapOpenInAppModule,
    installBootstrapMobileSidebarModule,
    installBootstrapBridgeModule,
  ]);
}
