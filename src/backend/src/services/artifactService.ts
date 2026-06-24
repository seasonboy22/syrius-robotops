import { ObjectStore } from "./objectStore.js";
import { ChecksumService } from "./checksumService.js";
import { createHash } from "node:crypto";
import {
  ArtifactMeta,
  UploadResult,
  ArtifactListOptions,
  ArtifactListResult,
} from "../types/artifact.js";
import {
  ArtifactNotFoundError,
  InvalidArtifactIdError,
  ArtifactReferencedError,
  ArtifactDuplicateChecksumError,
} from "../errors/appErrors.js";

const SAFE_ID_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function generateId(fileName: string): string {
  const slug = slugify(fileName.replace(/\.[^.]+$/, ""));
  const nanoid = () => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  };
  return `${slug || "artifact"}-${nanoid()}`;
}

function validateArtifactId(id: string): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new InvalidArtifactIdError(id);
  }
}

export class ArtifactService {
  private obs: ObjectStore;
  private checksumService: ChecksumService;

  constructor(obs: ObjectStore, checksumService: ChecksumService) {
    this.obs = obs;
    this.checksumService = checksumService;
  }

  async uploadFromBuffer(
    fileName: string,
    buffer: Buffer,
    options?: {
      tags?: string[];
      metadata?: Record<string, unknown>;
      customId?: string;
    }
  ): Promise<UploadResult> {
    const checksum = computeBufferSha256(buffer);

    const existing = await this.findByChecksum(checksum);
    if (existing) {
      return { status: "deduplicated", artifact: existing };
    }

    const artifactId = options?.customId ?? generateId(fileName);

    if (options?.customId) {
      validateArtifactId(artifactId);
    }

    const exists = await this.obs.exists(`v1/artifacts/${artifactId}_meta`);
    if (exists) {
      return { status: "failed", error: "Artifact ID already exists" };
    }

    if (buffer.length > MAX_FILE_SIZE) {
      return { status: "failed", error: "FILE_TOO_LARGE" };
    }

    const contentType = inferContentType(fileName);

    await this.obs.putBuffer(`v1/artifacts/${artifactId}`, buffer, contentType);

    const meta: ArtifactMeta = {
      id: artifactId,
      fileName,
      size: buffer.length,
      checksum,
      contentType,
      createdAt: new Date().toISOString(),
      refCount: 0,
      tags: options?.tags ?? [],
      metadata: options?.metadata ?? {},
    };

    await this.obs.putJson(`v1/artifacts/${artifactId}_meta`, meta);

    return { status: "success", artifact: meta };
  }

  async upload(
    filePath: string,
    options?: {
      tags?: string[];
      metadata?: Record<string, unknown>;
      customId?: string;
      onProgress?: (progress: { bytesSent: number; totalBytes: number; percentage: number }) => void;
      abortSignal?: AbortSignal;
    }
  ): Promise<UploadResult> {
    const { stat, readFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const s = await stat(filePath);
    if (s.size > MAX_FILE_SIZE) {
      return { status: "failed", error: "FILE_TOO_LARGE" };
    }

    const checksum = await this.checksumService.computeSha256(filePath, {
      abortSignal: options?.abortSignal,
    });

    const existing = await this.findByChecksum(checksum);
    if (existing) {
      return { status: "deduplicated", artifact: existing };
    }

    const fileName = path.basename(filePath);
    const artifactId = options?.customId ?? generateId(fileName);

    if (options?.customId) {
      validateArtifactId(artifactId);
    }

    const exists = await this.obs.exists(`v1/artifacts/${artifactId}_meta`);
    if (exists) {
      return { status: "failed", error: "Artifact ID already exists" };
    }

    const contentType = inferContentType(fileName);
    const fileBuffer = await readFile(filePath);

    await this.obs.putBuffer(`v1/artifacts/${artifactId}`, fileBuffer, contentType);

    const meta: ArtifactMeta = {
      id: artifactId,
      fileName,
      size: s.size,
      checksum,
      contentType,
      createdAt: new Date().toISOString(),
      refCount: 0,
      tags: options?.tags ?? [],
      metadata: options?.metadata ?? {},
    };

    await this.obs.putJson(`v1/artifacts/${artifactId}_meta`, meta);

    return { status: "success", artifact: meta };
  }

  async uploadBatch(
    filePaths: string[],
    options?: {
      tags?: string[];
      metadata?: Record<string, unknown>;
      onFileProgress?: (filePath: string, progress: { bytesSent: number; totalBytes: number; percentage: number }) => void;
      onFileComplete?: (filePath: string, result: UploadResult) => void;
      abortSignal?: AbortSignal;
    }
  ): Promise<UploadResult[]> {
    const results: UploadResult[] = [];

    for (const fp of filePaths) {
      try {
        const result = await this.upload(fp, {
          tags: options?.tags,
          metadata: options?.metadata,
          onProgress: options?.onFileProgress
            ? (p) => options.onFileProgress!(fp, p)
            : undefined,
          abortSignal: options?.abortSignal,
        });
        results.push(result);
        options?.onFileComplete?.(fp, result);
      } catch (err) {
        const result: UploadResult = { status: "failed", error: (err as Error).message };
        results.push(result);
        options?.onFileComplete?.(fp, result);
      }
    }

    return results;
  }

  async list(options?: ArtifactListOptions): Promise<ArtifactListResult> {
    const dirs = await this.obs.list("v1/artifacts");
    const metaFiles = dirs.filter(
      (d) => d.type === "file" && d.name.endsWith("_meta")
    );

    const items: ArtifactMeta[] = [];
    for (const mf of metaFiles) {
      try {
        const artifactId = mf.name.replace(/_meta$/, "");
        const meta = await this.readMeta(artifactId);
        items.push(meta);
      } catch {
        // Skip corrupted meta
      }
    }

    let filtered = items;
    if (options?.filter?.fileName) {
      const substr = options.filter.fileName.toLowerCase();
      filtered = filtered.filter((m) =>
        m.fileName.toLowerCase().includes(substr)
      );
    }
    if (options?.filter?.contentType) {
      filtered = filtered.filter(
        (m) => m.contentType === options.filter!.contentType
      );
    }
    if (options?.filter?.checksum) {
      filtered = filtered.filter(
        (m) => m.checksum === options.filter!.checksum
      );
    }
    if (options?.filter?.tags && options.filter.tags.length > 0) {
      filtered = filtered.filter((m) =>
        options.filter!.tags!.some((t) => m.tags.includes(t))
      );
    }

    const sortField = options?.sort?.field ?? "createdAt";
    const sortOrder = options?.sort?.order ?? "desc";
    filtered.sort((a, b) => {
      const va = a[sortField];
      const vb = b[sortField];
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortOrder === "asc" ? cmp : -cmp;
    });

    const total = filtered.length;
    if (options?.pagination) {
      const { offset, limit } = options.pagination;
      filtered = filtered.slice(offset, offset + limit);
    }

    return { items: filtered, total };
  }

  async get(artifactId: string): Promise<ArtifactMeta> {
    validateArtifactId(artifactId);
    return this.readMeta(artifactId);
  }

  async update(
    artifactId: string,
    patch: { tags?: string[]; metadata?: Record<string, unknown> }
  ): Promise<ArtifactMeta> {
    validateArtifactId(artifactId);
    const current = await this.readMeta(artifactId);

    const updated: ArtifactMeta = {
      ...current,
      tags: patch.tags ?? current.tags,
      metadata: patch.metadata ?? current.metadata,
    };

    await this.obs.putJson(`v1/artifacts/${artifactId}_meta`, updated);
    return updated;
  }

  async remove(artifactId: string): Promise<void> {
    validateArtifactId(artifactId);
    const meta = await this.readMeta(artifactId);

    if (meta.refCount > 0) {
      throw new ArtifactReferencedError(meta.refCount);
    }

    await this.obs.deletePath(`v1/artifacts/${artifactId}`);
    await this.obs.deletePath(`v1/artifacts/${artifactId}_meta`);
  }

  async download(artifactId: string, destinationPath: string): Promise<string> {
    validateArtifactId(artifactId);
    const meta = await this.readMeta(artifactId);

    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");

    const response = await this.obs.get(`v1/artifacts/${artifactId}`);
    if (!response.ok) {
      throw new ArtifactNotFoundError(artifactId);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const outputPath = join(destinationPath, meta.fileName);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);

    return outputPath;
  }

  async getArtifactPath(artifactId: string): Promise<string> {
    validateArtifactId(artifactId);
    const path = await this.obs.getStoragePath(`v1/artifacts/${artifactId}`);
    if (!path) {
      throw new ArtifactNotFoundError(artifactId);
    }
    return path;
  }

  async incrementRefCount(artifactId: string): Promise<void> {
    validateArtifactId(artifactId);
    const meta = await this.readMeta(artifactId);
    meta.refCount += 1;
    await this.obs.putJson(`v1/artifacts/${artifactId}_meta`, meta);
  }

  async decrementRefCount(artifactId: string): Promise<void> {
    validateArtifactId(artifactId);
    const meta = await this.readMeta(artifactId);
    if (meta.refCount <= 0) {
      meta.refCount = 0;
    } else {
      meta.refCount -= 1;
    }
    await this.obs.putJson(`v1/artifacts/${artifactId}_meta`, meta);
  }

  async runRefCountAudit(): Promise<{ corrected: number; inconsistencies: number }> {
    const { items: artifacts } = await this.list();
    const actualCounts = new Map<string, number>();

    for (const art of artifacts) {
      actualCounts.set(art.id, 0);
    }

    const solutionDirs = await this.obs.list("v1/solutions");
    const artifactNamespaces = ["upgrade-packages", "maps"];

    for (const sol of solutionDirs.filter((d) => d.type === "directory")) {
      for (const ns of artifactNamespaces) {
        try {
          const resources = await this.obs.list(`v1/solutions/${sol.name}/${ns}`);
          for (const res of resources.filter((r) => r.type === "file" && r.name !== ".keep")) {
            try {
              const content = await this.obs.getJson<{
                artifactRef?: { artifactId: string };
              }>(`v1/solutions/${sol.name}/${ns}/${res.name}`);
              if (content?.artifactRef?.artifactId) {
                const aid = content.artifactRef.artifactId;
                actualCounts.set(aid, (actualCounts.get(aid) ?? 0) + 1);
              }
            } catch {
              // Skip
            }
          }
        } catch {
          // Namespace might not exist
        }
      }
    }

    let corrected = 0;
    let inconsistencies = 0;

    for (const art of artifacts) {
      const actual = actualCounts.get(art.id) ?? 0;
      if (art.refCount !== actual) {
        inconsistencies++;
        art.refCount = actual;
        await this.obs.putJson(`v1/artifacts/${art.id}_meta`, art);
        corrected++;
      }
    }

    return { corrected, inconsistencies };
  }

  private async readMeta(artifactId: string): Promise<ArtifactMeta> {
    const meta = await this.obs.getJson<ArtifactMeta>(
      `v1/artifacts/${artifactId}_meta`
    );
    if (!meta) {
      throw new ArtifactNotFoundError(artifactId);
    }
    return meta;
  }

  private async findByChecksum(
    checksum: string
  ): Promise<ArtifactMeta | null> {
    const { items } = await this.list({
      filter: { checksum },
    });
    return items.length > 0 ? items[0] : null;
  }
}

function inferContentType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    fw: "application/x-firmware",
    elf: "application/x-elf",
    zip: "application/zip",
    bin: "application/octet-stream",
    gz: "application/gzip",
    tar: "application/x-tar",
    "7z": "application/x-7z-compressed",
    pdf: "application/pdf",
    json: "application/json",
    xml: "application/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
    txt: "text/plain",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}

function computeBufferSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
