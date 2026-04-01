#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(projectRoot, "dist", "cli.js");
const allowedNodeModuleExtensions = new Set([".cjs", ".js", ".json", ".mjs", ".node"]);
const alwaysIncludedNodeModuleBasenames = new Set(["spawn-helper"]);

async function main() {
  await assertExists("dist/cli.js");
  await assertExists("dist/assets/styles/picodex.css");
  await assertExists("dist/assets/images/import.svg");
  await assertExists("app.asar");

  const files = [];
  await addFile(files, "package.json", Buffer.from(renderEmbeddedPackageJson(), "utf8"), 0o644);
  await addTree(files, "dist");
  await addTree(files, "app.asar");

  for (const packagePath of await collectRuntimePackagePaths()) {
    await addTree(files, packagePath, {
      include: includeNodeModuleFile,
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const payloadJson = JSON.stringify({ files });
  const payloadGzip = gzipSync(Buffer.from(payloadJson, "utf8"), { level: 9 });
  const payloadHash = sha256(payloadGzip);
  const launcher = renderLauncher({
    payloadBase64: payloadGzip.toString("base64"),
    payloadHash,
  });

  await writeFile(outputPath, launcher, "utf8");
  await chmod(outputPath, 0o755);

  console.log(`Wrote ${relative(projectRoot, outputPath)} (${payloadHash})`);
}

async function assertExists(path) {
  await stat(join(projectRoot, path)).catch(() => {
    throw new Error(`Missing required build input: ${path}`);
  });
}

async function addTree(files, relativePath, options = {}) {
  const absolutePath = join(projectRoot, relativePath);
  const entry = await stat(absolutePath).catch(() => null);
  if (!entry) {
    throw new Error(`Missing required path: ${relativePath}`);
  }

  if (entry.isFile()) {
    await addFileFromDisk(files, relativePath, options.include);
    return;
  }

  if (!entry.isDirectory()) {
    throw new Error(`Unsupported entry type: ${relativePath}`);
  }

  await walkDirectory(files, relativePath, options.include);
}

async function walkDirectory(files, relativeDirectory, include) {
  const absoluteDirectory = join(projectRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const childRelativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(files, childRelativePath, include);
      continue;
    }

    if (entry.isFile()) {
      await addFileFromDisk(files, childRelativePath, include);
    }
  }
}

async function addFileFromDisk(files, relativePath, include) {
  const normalizedPath = normalizeManifestPath(relativePath);
  if (include && !include(normalizedPath)) {
    return;
  }

  const absolutePath = join(projectRoot, relativePath);
  const fileStat = await stat(absolutePath);
  const data = await readFile(absolutePath);
  await addFile(files, normalizedPath, data, fileStat.mode & 0o777);
}

async function addFile(files, path, data, mode) {
  files.push({
    path: normalizeManifestPath(path),
    data: data.toString("base64"),
    mode,
  });
}

function includeNodeModuleFile(relativePath) {
  const basename = relativePath.split("/").at(-1) ?? "";
  if (basename === "package.json") {
    return true;
  }
  if (alwaysIncludedNodeModuleBasenames.has(basename)) {
    return true;
  }
  return allowedNodeModuleExtensions.has(extname(basename));
}

function normalizeManifestPath(path) {
  return path.split("\\").join("/");
}

async function collectRuntimePackagePaths() {
  const rootPackageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
  const packageEntries = packageLock?.packages;
  if (!packageEntries || typeof packageEntries !== "object") {
    throw new Error("package-lock.json does not contain a supported packages map.");
  }

  const directDependencyNames = Object.keys(rootPackageJson.dependencies ?? {});
  const reachablePackagePaths = new Set();
  const queue = directDependencyNames.map((name) => normalizeManifestPath(join("node_modules", name)));

  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (!packagePath || reachablePackagePaths.has(packagePath)) {
      continue;
    }

    const packageInfo = packageEntries[packagePath];
    if (!packageInfo || typeof packageInfo !== "object") {
      throw new Error(`Runtime dependency is missing from package-lock.json: ${packagePath}`);
    }

    reachablePackagePaths.add(packagePath);

    const dependencyNames = [
      ...Object.keys(packageInfo.dependencies ?? {}),
      ...Object.keys(packageInfo.optionalDependencies ?? {}),
    ];

    for (const dependencyName of dependencyNames) {
      const dependencyPath = resolveDependencyPackagePath(packagePath, dependencyName, packageEntries);
      if (dependencyPath) {
        queue.push(dependencyPath);
      }
    }
  }

  return compressPackagePaths([...reachablePackagePaths]);
}

function resolveDependencyPackagePath(packagePath, dependencyName, packageEntries) {
  let currentPackagePath = packagePath;

  while (true) {
    const candidatePath = normalizeManifestPath(
      currentPackagePath
        ? join(currentPackagePath, "node_modules", dependencyName)
        : join("node_modules", dependencyName),
    );
    if (candidatePath in packageEntries) {
      return candidatePath;
    }

    const parentPackagePath = getParentPackagePath(currentPackagePath);
    if (parentPackagePath === null) {
      return null;
    }
    currentPackagePath = parentPackagePath;
  }
}

function getParentPackagePath(packagePath) {
  if (!packagePath) {
    return null;
  }

  const segments = normalizeManifestPath(packagePath).split("/");
  const lastNodeModulesIndex = segments.lastIndexOf("node_modules");
  if (lastNodeModulesIndex < 0) {
    return null;
  }

  return segments.slice(0, lastNodeModulesIndex).join("/");
}

function compressPackagePaths(packagePaths) {
  const sortedPackagePaths = [...packagePaths].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const minimalPackagePaths = [];

  for (const packagePath of sortedPackagePaths) {
    const isCoveredByParent = minimalPackagePaths.some((parentPackagePath) =>
      packagePath.startsWith(`${parentPackagePath}/node_modules/`),
    );
    if (!isCoveredByParent) {
      minimalPackagePaths.push(packagePath);
    }
  }

  return minimalPackagePaths.sort((left, right) => left.localeCompare(right));
}

function renderEmbeddedPackageJson() {
  return JSON.stringify(
    {
      name: "picodex-single-runtime",
      private: true,
      type: "module",
    },
    null,
    2,
  );
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function renderLauncher({ payloadBase64, payloadHash }) {
  return `#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const PAYLOAD_HASH = "${payloadHash}";
const PAYLOAD_GZIP_BASE64 = "${payloadBase64}";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const extractionRoot = await ensurePayloadExtracted();
  const embeddedAsarPath = join(extractionRoot, "app.asar");
  const userArgv = process.argv.slice(2);
  const effectiveArgv = userArgv.includes("--asar")
    ? userArgv
    : ["--asar", embeddedAsarPath, ...userArgv];

  process.argv = [process.argv[0] ?? "node", process.argv[1] ?? "cli.js", ...effectiveArgv];
  await import(pathToFileURL(join(extractionRoot, "dist", "cli.js")).href);
}

async function ensurePayloadExtracted() {
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const bundleRoot = join(cacheHome, "picodex", "single", PAYLOAD_HASH);
  const markerPath = join(bundleRoot, ".complete");

  try {
    const marker = await readFile(markerPath, "utf8");
    if (marker.trim() === PAYLOAD_HASH) {
      return bundleRoot;
    }
  } catch {
    // continue and rebuild the cache
  }

  await mkdir(dirname(bundleRoot), { recursive: true });
  const tempRoot = \`\${bundleRoot}.tmp-\${process.pid}-\${Date.now()}\`;
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });

  try {
    const payload = JSON.parse(gunzipSync(Buffer.from(PAYLOAD_GZIP_BASE64, "base64")).toString("utf8"));
    for (const file of payload.files) {
      const targetPath = join(tempRoot, file.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, Buffer.from(file.data, "base64"));
      if (typeof file.mode === "number") {
        await chmod(targetPath, file.mode);
      }
    }

    await writeFile(join(tempRoot, ".complete"), PAYLOAD_HASH, "utf8");

    try {
      await rename(tempRoot, bundleRoot);
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true });
      const marker = await readFile(markerPath, "utf8").catch(() => null);
      if (marker?.trim() !== PAYLOAD_HASH) {
        throw error;
      }
    }
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  await stat(markerPath);
  return bundleRoot;
}
`;
}

await main();
