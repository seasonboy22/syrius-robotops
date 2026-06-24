import * as store from "../objectStore/store.js";

export interface ObjectStoreResource {
  name: string;
  type: "file" | "directory";
  contentType?: string;
  size?: number;
}

class StoreResponse {
  private content: Buffer;
  private contentType: string;
  ok: boolean;

  constructor(content: Buffer | null, contentType: string) {
    this.content = content ?? Buffer.alloc(0);
    this.contentType = contentType;
    this.ok = content !== null;
  }

  async text(): Promise<string> {
    return this.content.toString("utf-8");
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.content.buffer.slice(
      this.content.byteOffset,
      this.content.byteOffset + this.content.byteLength
    ) as ArrayBuffer;
  }
}

function parsePath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export class ObjectStore {
  async exists(path: string): Promise<boolean> {
    return store.exists(parsePath(path));
  }

  async put(path: string, body: Buffer | string, contentType?: string): Promise<void> {
    const data = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
    await store.put(parsePath(path), data, contentType ?? "application/octet-stream");
  }

  async putJson(path: string, data: unknown): Promise<void> {
    await this.put(path, JSON.stringify(data), "application/json");
  }

  async putBuffer(path: string, data: Buffer, contentType: string): Promise<void> {
    await this.put(path, data, contentType);
  }

  async list(path: string): Promise<ObjectStoreResource[]> {
    try {
      return await store.list(parsePath(path));
    } catch {
      return [];
    }
  }

  async getJson<T>(path: string): Promise<T | null> {
    const result = await store.get(parsePath(path));
    if (!result || result.type !== "file") return null;
    try {
      return JSON.parse(result.content.toString("utf-8")) as T;
    } catch {
      return null;
    }
  }

  async getStoragePath(path: string): Promise<string | null> {
    return store.getStoragePath(parsePath(path));
  }

  async get(path: string): Promise<StoreResponse> {
    const result = await store.get(parsePath(path));
    if (!result || result.type !== "file") {
      return new StoreResponse(null, "");
    }
    return new StoreResponse(result.content, result.contentType);
  }

  async deletePath(path: string): Promise<boolean> {
    return store.remove(parsePath(path));
  }
}
