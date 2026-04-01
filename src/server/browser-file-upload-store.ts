import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";

import Busboy from "busboy";

const DEFAULT_UPLOAD_ROOT = join(tmpdir(), "picodex-browser-uploads");
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_FILES = 32;

export interface BrowserFileUploadStoreOptions {
  rootDirectory?: string;
  ttlMs?: number;
  maxFileBytes?: number;
  maxFiles?: number;
}

export interface UploadedHostFile {
  label: string;
  path: string;
  fsPath: string;
}

export class BrowserFileUploadStore {
  private readonly rootDirectory: string;
  private readonly ttlMs: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;

  constructor(options: BrowserFileUploadStoreOptions = {}) {
    this.rootDirectory = options.rootDirectory ?? DEFAULT_UPLOAD_ROOT;
    this.ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_UPLOAD_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_UPLOAD_FILES;
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    await this.sweepExpiredUploads();
  }

  async handleMultipartUpload(request: IncomingMessage): Promise<{ files: UploadedHostFile[] }> {
    await this.initialize();

    const uploadDirectory = await mkdtemp(join(this.rootDirectory, `${Date.now()}-`));
    const files: UploadedHostFile[] = [];
    const usedFileNames = new Set<string>();
    const writeTasks: Promise<void>[] = [];
    let parserError: Error | null = null;
    let filesLimitReached = false;

    try {
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !contentType.toLowerCase().includes("multipart/form-data")) {
        throw new Error("Upload must use multipart/form-data.");
      }

      const parser = Busboy({
        headers: request.headers,
        limits: {
          fileSize: this.maxFileBytes,
          files: this.maxFiles,
        },
      });

      parser.on("file", (_fieldName, fileStream, info) => {
        const originalName = sanitizeFileName(info.filename);
        const nextPath = join(uploadDirectory, makeUniqueFileName(originalName, usedFileNames));
        const fileLabel = stripFileExtension(basename(nextPath)) || basename(nextPath) || "File";
        const uploadedFile: UploadedHostFile = {
          label: fileLabel,
          path: nextPath,
          fsPath: nextPath,
        };
        files.push(uploadedFile);

        const task = (async () => {
          let exceededLimit = false;
          fileStream.on("limit", () => {
            exceededLimit = true;
          });

          await pipeline(fileStream, createWriteStream(nextPath));

          if (exceededLimit) {
            await unlink(nextPath).catch(() => {});
            throw new Error(
              `File exceeds the ${formatBytes(this.maxFileBytes)} upload limit: ${originalName}`,
            );
          }
        })().catch(async (error) => {
          parserError = error instanceof Error ? error : new Error(String(error));
          await unlink(nextPath).catch(() => {});
        });

        writeTasks.push(task);
      });

      parser.on("filesLimit", () => {
        filesLimitReached = true;
      });

      const parsePromise = new Promise<void>((resolve, reject) => {
        parser.once("error", (error) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        parser.once("finish", () => {
          resolve();
        });
      });

      request.pipe(parser);
      await parsePromise;
      await Promise.all(writeTasks);

      if (parserError) {
        throw parserError;
      }

      if (filesLimitReached) {
        throw new Error(`You can upload at most ${this.maxFiles} files at once.`);
      }

      if (files.length === 0) {
        throw new Error("Select at least one file to upload.");
      }

      return { files };
    } catch (error) {
      await Promise.allSettled(writeTasks);
      await rm(uploadDirectory, { recursive: true, force: true }).catch(() => {});
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async sweepExpiredUploads(): Promise<void> {
    const expiryCutoff = Date.now() - this.ttlMs;
    const entries = await readdir(this.rootDirectory, { withFileTypes: true }).catch(() => []);

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) {
          return;
        }

        const targetPath = join(this.rootDirectory, entry.name);
        try {
          const info = await stat(targetPath);
          if (info.mtimeMs >= expiryCutoff) {
            return;
          }
          await rm(targetPath, { recursive: true, force: true });
        } catch {
          // Ignore stale entry cleanup failures.
        }
      }),
    );
  }
}

function sanitizeFileName(input: string): string {
  const trimmed = basename((input || "").trim()).replace(/[\u0000-\u001f\u007f/\\]+/g, "_");
  return trimmed || `upload-${randomUUID()}.bin`;
}

function makeUniqueFileName(fileName: string, existingNames: Set<string>): string {
  if (!existingNames.has(fileName)) {
    existingNames.add(fileName);
    return fileName;
  }

  const extension = extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length) || "upload";
  let counter = 1;
  while (true) {
    const candidate = `${baseName}-${counter}${extension}`;
    if (!existingNames.has(candidate)) {
      existingNames.add(candidate);
      return candidate;
    }
    counter += 1;
  }
}

function stripFileExtension(fileName: string): string {
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return fileName;
  }
  return fileName.slice(0, extensionIndex);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} bytes`;
}
