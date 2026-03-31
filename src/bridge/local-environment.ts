import { join, resolve } from "node:path";

import {
  DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME,
  type LocalEnvironmentAction,
  type LocalEnvironmentDocument,
} from "./shared.js";

export function buildLocalEnvironmentDirectoryPath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), ".codex", "environments");
}

export function buildDefaultLocalEnvironmentConfigPath(workspaceRoot: string): string {
  return join(
    buildLocalEnvironmentDirectoryPath(workspaceRoot),
    DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME,
  );
}

export function parseLocalEnvironmentDocument(raw: string): LocalEnvironmentDocument {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const environment: LocalEnvironmentDocument = {
    version: 1,
    name: "local",
    setup: {
      script: "",
    },
    actions: [],
  };

  let currentSection:
    | "root"
    | "setup"
    | "setup.darwin"
    | "setup.linux"
    | "setup.win32"
    | "actions" = "root";
  let currentAction: LocalEnvironmentAction | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line === "[setup]") {
      if (currentAction) {
        maybePushLocalEnvironmentAction(environment.actions, currentAction);
        currentAction = null;
      }
      currentSection = "setup";
      continue;
    }

    if (line === "[setup.darwin]" || line === "[setup.linux]" || line === "[setup.win32]") {
      if (currentAction) {
        maybePushLocalEnvironmentAction(environment.actions, currentAction);
        currentAction = null;
      }
      currentSection = line.slice(1, -1) as "setup.darwin" | "setup.linux" | "setup.win32";
      continue;
    }

    if (line === "[[actions]]") {
      if (currentAction) {
        maybePushLocalEnvironmentAction(environment.actions, currentAction);
      }
      currentAction = {
        name: "",
        command: "",
      };
      currentSection = "actions";
      continue;
    }

    const keyMatch = rawLine.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!keyMatch) {
      continue;
    }

    const [, key, rawValue] = keyMatch;
    let value: unknown;
    if (rawValue.startsWith("'''") || rawValue.startsWith('"""')) {
      const parsed = readTomlMultilineString(lines, index, rawValue);
      value = parsed.value;
      index = parsed.nextIndex;
    } else {
      value = parseTomlScalar(rawValue);
    }

    switch (currentSection) {
      case "root":
        if (key === "version" && typeof value === "number") {
          environment.version = value;
        } else if (key === "name" && typeof value === "string") {
          environment.name = value;
        }
        break;
      case "setup":
        if (key === "script" && typeof value === "string") {
          environment.setup.script = value;
        }
        break;
      case "setup.darwin":
        if (key === "script" && typeof value === "string") {
          environment.setup.darwin = { script: value };
        }
        break;
      case "setup.linux":
        if (key === "script" && typeof value === "string") {
          environment.setup.linux = { script: value };
        }
        break;
      case "setup.win32":
        if (key === "script" && typeof value === "string") {
          environment.setup.win32 = { script: value };
        }
        break;
      case "actions":
        if (!currentAction) {
          currentAction = {
            name: "",
            command: "",
          };
        }
        if (key === "name" && typeof value === "string") {
          currentAction.name = value;
        } else if (key === "icon" && typeof value === "string") {
          currentAction.icon = value;
        } else if (key === "command" && typeof value === "string") {
          currentAction.command = value;
        } else if (
          key === "platform" &&
          (value === "darwin" || value === "linux" || value === "win32")
        ) {
          currentAction.platform = value;
        }
        break;
    }
  }

  if (currentAction) {
    maybePushLocalEnvironmentAction(environment.actions, currentAction);
  }

  return environment;
}

export function stripFileExtension(fileName: string): string {
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return fileName;
  }
  return fileName.slice(0, extensionIndex);
}

function maybePushLocalEnvironmentAction(
  actions: LocalEnvironmentAction[],
  action: LocalEnvironmentAction,
): void {
  const name = action.name.trim();
  const command = action.command.trim();
  if (!name || !command) {
    return;
  }

  actions.push({
    name,
    command,
    ...(action.icon ? { icon: action.icon } : {}),
    ...(action.platform ? { platform: action.platform } : {}),
  });
}

function parseTomlScalar(rawValue: string): unknown {
  const value = rawValue.trim();
  if (!value) {
    return "";
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readTomlMultilineString(
  lines: string[],
  startIndex: number,
  rawValue: string,
): { value: string; nextIndex: number } {
  const delimiter = rawValue.startsWith('"""') ? '"""' : "'''";
  const initial = rawValue.slice(delimiter.length);
  if (initial.endsWith(delimiter)) {
    return {
      value: decodeTomlMultilineString(initial.slice(0, -delimiter.length), delimiter),
      nextIndex: startIndex,
    };
  }

  const collected: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === delimiter) {
      return {
        value: decodeTomlMultilineString(collected.join("\n"), delimiter),
        nextIndex: index,
      };
    }
    if (line.endsWith(delimiter)) {
      collected.push(line.slice(0, -delimiter.length));
      return {
        value: decodeTomlMultilineString(collected.join("\n"), delimiter),
        nextIndex: index,
      };
    }
    collected.push(line);
  }

  throw new Error("Unterminated multiline TOML string.");
}

function decodeTomlMultilineString(value: string, delimiter: string): string {
  if (delimiter === "'''") {
    return value;
  }

  return value.replace(/\\"""/g, '"""').replace(/\\\\/g, "\\");
}
