import {
  readFile,
  writeFile,
  unlink,
  readdir,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { join, extname, basename } from "node:path";

let baseDir: string = join(process.cwd(), "data");

export function configure(dir: string): void {
  baseDir = dir;
}

const SAFE_NAME_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;

function validateName(name: string): void {
  if (name === "." || name === "..") {
    throw new Error(`Invalid name: "${name}"`);
  }
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid name: "${name}". Must start with alphanumeric, underscore, or hyphen. Allowed: letters, digits, underscores, hyphens, dots.`
    );
  }
}

function validatePathParts(parts: string[]): void {
  for (const part of parts) {
    validateName(part);
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

const MIME_TO_EXT: Record<string, string> = {
  "application/json": ".json",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/css": ".css",
  "text/csv": ".csv",
  "text/xml": ".xml",
  "text/yaml": ".yaml",
  "text/markdown": ".md",
  "application/xml": ".xml",
  "application/yaml": ".yaml",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "application/x-7z-compressed": ".7z",
  "application/x-rar-compressed": ".rar",
  "application/octet-stream": ".bin",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "application/x-firmware": ".fw",
  "application/x-elf": ".elf",
};

const EXT_TO_MIME: Record<string, string> = {};
for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
  if (!EXT_TO_MIME[ext]) {
    EXT_TO_MIME[ext] = mime;
  }
}
Object.assign(EXT_TO_MIME, {
  ".jpeg": "image/jpeg",
  ".yml": "text/yaml",
  ".htm": "text/html",
  ".log": "text/plain",
  ".conf": "text/plain",
  ".cfg": "text/plain",
  ".ini": "text/plain",
  ".dat": "application/octet-stream",
  ".img": "application/octet-stream",
  ".iso": "application/octet-stream",
  ".deb": "application/octet-stream",
  ".rpm": "application/octet-stream",
  ".apk": "application/octet-stream",
  ".exe": "application/octet-stream",
  ".msi": "application/octet-stream",
  ".dll": "application/octet-stream",
  ".so": "application/octet-stream",
  ".dylib": "application/octet-stream",
  ".map": "application/json",
});

export function getExtension(mimeType: string): string {
  return MIME_TO_EXT[mimeType.toLowerCase().split(";")[0].trim()] ?? ".bin";
}

export function getMimeType(ext: string): string {
  return EXT_TO_MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

export interface ResourceInfo {
  name: string;
  type: "file" | "directory";
  contentType?: string;
  size?: number;
}

export type GetResult =
  | { type: "directory"; children: ResourceInfo[] }
  | { type: "file"; content: Buffer; contentType: string };

function resolvePath(parts: string[]): string {
  return join(baseDir, ...parts);
}

async function findFile(
  dirPath: string,
  baseName: string
): Promise<string | null> {
  try {
    const files = await readdir(dirPath);
    for (const file of files) {
      const ext = extname(file);
      const name = basename(file, ext);
      if (name === baseName) {
        const filePath = join(dirPath, file);
        try {
          const s = await stat(filePath);
          if (s.isFile()) {
            return file;
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function list(pathParts: string[]): Promise<ResourceInfo[]> {
  validatePathParts(pathParts);
  const dirPath = resolvePath(pathParts);

  if (pathParts.length === 0) {
    await ensureDir(dirPath);
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    throw new Error(
      `Directory not found: "${pathParts.join("/") || "/"}"`
    );
  }

  const seen = new Map<string, ResourceInfo>();

  for (const entry of entries) {
    if (entry.isDirectory()) {
      seen.set(entry.name, { name: entry.name, type: "directory" });
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      const name = basename(entry.name, ext);
      if (!seen.has(name)) {
        try {
          const s = await stat(join(dirPath, entry.name));
          seen.set(name, {
            name,
            type: "file",
            contentType: getMimeType(ext),
            size: s.size,
          });
        } catch {
          seen.set(name, { name, type: "file", contentType: getMimeType(ext) });
        }
      }
    }
  }

  return Array.from(seen.values());
}

export async function get(
  pathParts: string[]
): Promise<GetResult | null> {
  validatePathParts(pathParts);

  if (pathParts.length === 0) {
    await ensureDir(baseDir);
    const children = await list([]);
    return { type: "directory", children };
  }

  const fsPath = resolvePath(pathParts);

  try {
    const s = await stat(fsPath);
    if (s.isDirectory()) {
      const children = await list(pathParts);
      return { type: "directory", children };
    }
  } catch {
    // not a directory entry
  }

  const parentDir = resolvePath(pathParts.slice(0, -1));
  const baseName = pathParts[pathParts.length - 1];

  const fileName = await findFile(parentDir, baseName);
  if (fileName) {
    const filePath = join(parentDir, fileName);
    const ext = extname(fileName);
    const content = await readFile(filePath);
    return { type: "file", content, contentType: getMimeType(ext) };
  }

  return null;
}

export async function exists(pathParts: string[]): Promise<boolean> {
  validatePathParts(pathParts);
  if (pathParts.length === 0) return true;

  const fsPath = resolvePath(pathParts);
  try {
    await stat(fsPath);
    return true;
  } catch {
    // not a directory
  }

  const parentDir = resolvePath(pathParts.slice(0, -1));
  const baseName = pathParts[pathParts.length - 1];
  const fileName = await findFile(parentDir, baseName);
  return fileName !== null;
}

export async function put(
  pathParts: string[],
  data: Buffer,
  contentType: string
): Promise<ResourceInfo> {
  validatePathParts(pathParts);
  if (pathParts.length === 0) {
    throw new Error("Resource path cannot be empty");
  }

  const parentParts = pathParts.slice(0, -1);

  for (let i = 0; i < parentParts.length; i++) {
    const ancestorParts = pathParts.slice(0, i + 1);
    const ancestorFsPath = resolvePath(ancestorParts);

    try {
      const s = await stat(ancestorFsPath);
      if (!s.isDirectory()) {
        throw new Error(
          `Cannot create resource: "${ancestorParts.join("/")}" already exists as a file`
        );
      }
    } catch (err) {
      if ((err as Error).message.includes("already exists as a file")) throw err;
    }

    const ancestorParentDir = resolvePath(ancestorParts.slice(0, -1));
    const ancestorBaseName = ancestorParts[ancestorParts.length - 1];
    const foundFile = await findFile(ancestorParentDir, ancestorBaseName);
    if (foundFile) {
      throw new Error(
        `Cannot create resource: "${ancestorParts.join("/")}" already exists as a file`
      );
    }
  }

  const targetPath = resolvePath(pathParts);
  try {
    const s = await stat(targetPath);
    if (s.isDirectory()) {
      throw new Error(
        `Cannot create file resource: "${pathParts.join("/")}" already exists as a directory`
      );
    }
  } catch (err) {
    if ((err as Error).message.includes("already exists as a directory")) throw err;
  }

  const ext = getExtension(contentType);
  const baseName = pathParts[pathParts.length - 1];

  const parentDir = resolvePath(parentParts);
  await ensureDir(parentDir);

  const existingFile = await findFile(parentDir, baseName);
  if (existingFile && extname(existingFile) !== ext) {
    await unlink(join(parentDir, existingFile));
  }

  const filePath = join(parentDir, `${baseName}${ext}`);
  await writeFile(filePath, data);

  const s = await stat(filePath);
  return {
    name: baseName,
    type: "file",
    contentType,
    size: s.size,
  };
}

export async function getStoragePath(pathParts: string[]): Promise<string | null> {
  validatePathParts(pathParts);
  if (pathParts.length === 0) return null;

  const parentDir = resolvePath(pathParts.slice(0, -1));
  const baseName = pathParts[pathParts.length - 1];

  const fileName = await findFile(parentDir, baseName);
  if (!fileName) return null;

  return join(parentDir, fileName);
}

export async function remove(pathParts: string[]): Promise<boolean> {
  validatePathParts(pathParts);
  if (pathParts.length === 0) {
    throw new Error("Root directory cannot be deleted");
  }

  const fsPath = resolvePath(pathParts);
  let deleted = false;

  try {
    const s = await stat(fsPath);
    if (s.isDirectory()) {
      await rm(fsPath, { recursive: true, force: true });
      deleted = true;
    }
  } catch {
    // not a directory
  }

  const parentDir = resolvePath(pathParts.slice(0, -1));
  const baseName = pathParts[pathParts.length - 1];

  const fileName = await findFile(parentDir, baseName);
  if (fileName) {
    await unlink(join(parentDir, fileName));
    deleted = true;
  }

  return deleted;
}
