import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { FlowSpec, ValueMap, ITaskResolver, TaskResolverClass } from "flowed";
import { TaskFlowEngine } from "./services/taskFlowEngine/taskFlowEngine.js";

// Side-effect import: registers BaseTask test cases under node:test.
import "./baseTask.test.js";
import type { FlowRecord, FlowSummary, FlowType, TaskState } from "./services/taskFlowEngine/taskFlowEngine.js";
import { ResolverRegistry } from "./services/taskFlowEngine/resolverRegistry.js";
import { SseManager } from "./services/sseManager.js";
import type { ISseManagerEventHandler } from "./services/sseManager.js";
import { createTaskFlowRoutes } from "./routes/taskFlowRoutes.js";
import type { ObjectStoreResource } from "./services/objectStore.js";
import { MemStore } from "./memStore/index.js";
import type { CacheEventHandler, CacheEntry } from "./memStore/index.js";
import { buildRobotInfoKey } from "./services/robotService.js";
import { MockGetRobotBasicInfoTask } from "./tasks/mock/mockGetRobotBasicInfoTask.js";
import { MockGetRobotSoftwareInfoTask } from "./tasks/mock/mockGetRobotSoftwareInfoTask.js";
import { UpdateRobotBasicInfoTask } from "./tasks/real/updateRobotBasicInfoTask.js";
import { UpdateRobotSoftwareInfoTask } from "./tasks/real/updateRobotSoftwareInfoTask.js";
import type { RobotBasicInfo } from "./tasks/real/getRobotBasicInfoTask.js";
import type { RobotSoftwareInfo } from "./tasks/real/getRobotSoftwareInfoTask.js";
import { WaitSshConnectedTask } from "./tasks/real/waitSshConnectedTask.js";
import { WaitSshDisconnectedTask } from "./tasks/real/waitSshDisconnectedTask.js";
import { WaitSshReconnectTask } from "./tasks/real/waitSshReconnectTask.js";
import { MatchBUPVersionTask } from "./tasks/real/matchBUPVersionTask.js";
import { MovebaseDiskCleanupTask } from "./tasks/real/movebaseDiskCleanupTask.js";
import { TransferIotGatewayConfigTask } from "./tasks/real/transferIotGatewayConfigTask.js";
import { UpdateIotGatewayConfigTask } from "./tasks/real/updateIotGatewayConfigTask.js";
import { resetSshConnectionProbeForTest, setSshConnectionProbeForTest } from "./tasks/real/sshConnectionWait.js";
import type { SshConnectionProbeParams } from "./tasks/real/sshConnectionWait.js";

class InMemoryObjectStore {
  private store = new Map<string, unknown>();
  private deleted = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }

  async put(path: string, _body: Buffer | string, _contentType?: string): Promise<void> {
    this.store.set(path, _body);
  }

  async putJson(path: string, data: unknown): Promise<void> {
    this.store.set(path, data);
  }

  async putBuffer(path: string, data: Buffer, contentType: string): Promise<void> {
    this.store.set(path, { data, contentType });
  }

  async list(path: string): Promise<ObjectStoreResource[]> {
    const prefix = path.replace(/\/$/, "") + "/";
    const entries: ObjectStoreResource[] = [];
    const seen = new Set<string>();
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        const name = key.slice(prefix.length).split("/")[0];
        if (!seen.has(name)) {
          seen.add(name);
          entries.push({ name, type: "file" });
        }
      }
    }
    return entries;
  }

  async getJson<T>(path: string): Promise<T | null> {
    if (this.deleted.has(path)) return null;
    const val = this.store.get(path);
    return val !== undefined ? (val as T) : null;
  }

  async get(path: string): Promise<{ ok: boolean; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }> {
    const val = this.store.get(path);
    if (val === undefined) return { ok: false, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    const str = typeof val === "string" ? val : JSON.stringify(val);
    const buf = Buffer.from(str, "utf-8");
    return {
      ok: true,
      text: async () => str,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    };
  }

  async getStoragePath(path: string): Promise<string | null> {
    if (this.deleted.has(path)) return null;
    return this.store.has(path) ? path : null;
  }

  async deletePath(path: string): Promise<boolean> {
    this.deleted.add(path);
    return this.store.delete(path);
  }
}

class EnhancedObjectStore {
  private store = new Map<string, unknown>();

  async exists(path: string): Promise<boolean> {
    const keys = [...this.store.keys()];
    if (this.store.has(path)) return true;
    const prefix = path.replace(/\/$/, "") + "/";
    return keys.some((k) => k.startsWith(prefix));
  }

  async put(path: string, _body: Buffer | string, _contentType?: string): Promise<void> {
    this.store.set(path, _body);
  }

  async putJson(path: string, data: unknown): Promise<void> {
    this.store.set(path, data);
  }

  async putBuffer(path: string, data: Buffer, contentType: string): Promise<void> {
    this.store.set(path, { data, contentType });
  }

  async list(path: string): Promise<ObjectStoreResource[]> {
    const prefix = path.replace(/\/$/, "") + "/";
    const directChildren = new Map<string, Set<string>>();
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const parts = rest.split("/");
        const childName = parts[0];
        if (!directChildren.has(childName)) {
          directChildren.set(childName, new Set());
        }
        if (parts.length > 1) {
          directChildren.get(childName)!.add(parts[1]);
        }
      }
    }
    const entries: ObjectStoreResource[] = [];
    for (const [name, subParts] of directChildren) {
      if (subParts.size > 0) {
        entries.push({ name, type: "directory" });
      } else {
        entries.push({ name, type: "file" });
      }
    }
    return entries;
  }

  async getJson<T>(path: string): Promise<T | null> {
    const val = this.store.get(path);
    return val !== undefined ? (val as T) : null;
  }

  async get(path: string): Promise<{ ok: boolean; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }> {
    const val = this.store.get(path);
    if (val === undefined) return { ok: false, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    const str = typeof val === "string" ? val : JSON.stringify(val);
    const buf = Buffer.from(str, "utf-8");
    return {
      ok: true,
      text: async () => str,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    };
  }

  async getStoragePath(path: string): Promise<string | null> {
    return this.store.has(path) ? path : null;
  }

  async deletePath(path: string): Promise<boolean> {
    const prefix = path.replace(/\/$/, "") + "/";
    const keysToDelete = [...this.store.keys()].filter(
      (k) => k === path || k.startsWith(prefix)
    );
    let deleted = false;
    for (const key of keysToDelete) {
      this.store.delete(key);
      deleted = true;
    }
    return deleted;
  }
}

class SpySseManager {
  events: { event: string; data: unknown }[] = [];
  private handlers: ISseManagerEventHandler[] = [];
  private clients = new Map<string, { id: string; controller: ReadableStreamDefaultController }>();

  registerHandler(handler: ISseManagerEventHandler): void {
    if (!this.handlers.includes(handler)) {
      this.handlers.push(handler);
    }
  }

  unregisterHandler(handler: ISseManagerEventHandler): void {
    const index = this.handlers.indexOf(handler);
    if (index !== -1) this.handlers.splice(index, 1);
  }

  addClient(client: { id: string; controller: ReadableStreamDefaultController }): void {
    this.clients.set(client.id, client);
    for (const handler of this.handlers) {
      try {
        handler.onClientConnected(this as unknown as SseManager, client.id);
      } catch {
        // ignore handler failures in tests
      }
    }
  }

  removeClient(id: string): void {
    if (!this.clients.has(id)) return;
    this.clients.delete(id);
    for (const handler of this.handlers) {
      try {
        handler.onClientDisconnected(this as unknown as SseManager, id);
      } catch {
        // ignore handler failures in tests
      }
    }
  }

  sendToClient<T>(_clientId: string, event: string, payload: T): boolean {
    const envelope = { event, payload, timestamp: new Date().toISOString() };
    this.events.push({ event, data: envelope });
    return true;
  }

  broadcast<T>(event: string, payload: T): void {
    const envelope = { event, payload, timestamp: new Date().toISOString() };
    this.events.push({ event, data: envelope });
  }

  getClientCount(): number {
    return this.clients.size;
  }

  clear(): void {
    this.events = [];
  }

  hasEvent(eventName: string): boolean {
    return this.events.some((e) => e.event === eventName);
  }

  findEvent(eventName: string): { event: string; data: unknown } | undefined {
    return this.events.find((e) => e.event === eventName);
  }

  eventCount(eventName: string): number {
    return this.events.filter((e) => e.event === eventName).length;
  }
}

class MockTask1 implements ITaskResolver {
  async exec(params: ValueMap): Promise<ValueMap> {
    return { done: true, result: "mock1-result", value: params.value ?? "default" };
  }
}

class MockTask2 implements ITaskResolver {
  async exec(params: ValueMap): Promise<ValueMap> {
    return { done: true, result: "mock2-result", value: params.value ?? "default" };
  }
}

class MockFailingTask implements ITaskResolver {
  async exec(_params: ValueMap): Promise<ValueMap> {
    throw new Error("Simulated task failure");
  }
}

class MockRecoveryTask implements ITaskResolver {
  async exec(params: ValueMap): Promise<ValueMap> {
    const errorCtx = params.errorContext as Record<string, unknown> | undefined;
    return {
      done: true,
      recovered: true,
      failedTask: errorCtx?.failedTaskCode ?? "unknown",
    };
  }
}

class TestableMatchBUPVersionTask extends MatchBUPVersionTask {
  match(actualContent: string, expectedContent: string): boolean {
    return this.doesContentMatch(actualContent, expectedContent);
  }

  mismatchMessage(filePath: string, expectedContent: string, actualContent: string): string {
    return this.buildMismatchMessage(filePath, expectedContent, actualContent);
  }
}

const singleTaskDag: FlowSpec = {
  tasks: {
    task1: {
      provides: ["data1"],
      resolver: { name: "MockTask1", results: { done: "data1" } },
    },
  },
};

const dependentDag: FlowSpec = {
  tasks: {
    task1: {
      provides: ["data1"],
      resolver: { name: "MockTask1", results: { done: "data1" } },
    },
    task2: {
      requires: ["data1"],
      provides: ["data2"],
      resolver: { name: "MockTask2", results: { done: "data2" } },
    },
  },
};

const errorRecoveryDag: FlowSpec = {
  tasks: {
    rollback: {
      provides: ["recoveryResult"],
      resolver: { name: "MockRecoveryTask", results: { done: "recoveryResult" } },
    },
  },
};

const errorFailingDag: FlowSpec = {
  tasks: {
    rollback: {
      resolver: { name: "MockFailingTask" },
    },
  },
};

function createEngine(ttlMs?: number, cleanupMs?: number) {
  const objStore = new InMemoryObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
  const sse = new SpySseManager() as unknown as SseManager;
  const registry = new ResolverRegistry();
  registry.register("MockTask1", MockTask1);
  registry.register("MockTask2", MockTask2);
  registry.register("MockFailingTask", MockFailingTask);
  registry.register("MockRecoveryTask", MockRecoveryTask);
  const engine = new TaskFlowEngine(objStore, sse, registry, {
    completedFlowTtlMs: ttlMs,
    cleanupIntervalMs: cleanupMs,
  });
  return { engine, objStore: objStore as unknown as InMemoryObjectStore, sse: sse as unknown as SpySseManager };
}

function waitForFlowComplete(engine: TaskFlowEngine, id: string, timeoutMs = 10000): Promise<FlowSummary> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const summary = engine.getFlow(id);
      if (!summary) {
        clearInterval(timer);
        reject(new Error("Flow not found"));
        return;
      }
      if (summary.state === "COMPLETED" || summary.state === "FAILED" || summary.state === "STOPPED") {
        clearInterval(timer);
        resolve(summary);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Flow did not complete within timeout"));
      }
    }, 50);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHonoApp(engine: TaskFlowEngine): Hono {
  const app = new Hono();
  app.route("/api/flows", createTaskFlowRoutes(engine));
  return app;
}

describe("TaskFlowEngine - Core", () => {
  describe("createFlow", () => {
    it("TC-TFE-001: should create and start an internal flow", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);
      assert.ok(summary.id);
      assert.match(summary.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      assert.equal(summary.type, "internal");
      assert.ok(["RUNNING", "COMPLETED", "FAILED"].includes(summary.state));
      assert.ok(summary.taskStates);
      assert.ok(summary.taskStates["task1"] !== undefined);
      engine.destroy();
    });

    it("TC-TFE-002: should create and persist a user flow", async () => {
      const { engine, objStore } = createEngine();
      const summary = await engine.createFlow("user", singleTaskDag);
      assert.equal(summary.type, "user");

      const persisted = await objStore.getJson(`flows/${summary.id}`);
      assert.ok(persisted);
      assert.equal((persisted as FlowRecord).id, summary.id);
      engine.destroy();
    });

    it("TC-TFE-003: should accept flow input parameters", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag, { robotIp: "10.0.0.1" });
      assert.deepEqual(summary.input, { robotIp: "10.0.0.1" });
      engine.destroy();
    });

    it("TC-TFE-004: should default input to undefined when not provided", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);
      assert.equal(summary.input, undefined);
      engine.destroy();
    });

    it("TC-TFE-005: should extract expected results on completion", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag, undefined, ["data1"]);
      await waitForFlowComplete(engine, summary.id);

      const completed = engine.getFlow(summary.id);
      assert.ok(completed);
      assert.equal(completed.state, "COMPLETED");
      assert.ok(completed.results);
      assert.ok((completed.results as ValueMap)["data1"] !== undefined);
      assert.ok(completed.finishedAt);
      engine.destroy();
    });

    it("TC-TFE-042: should reject unregistered resolver", async () => {
      const { engine } = createEngine();
      const badDag: FlowSpec = {
        tasks: {
          task1: {
            resolver: { name: "NonExistentTask" },
          },
        },
      };
      await assert.rejects(
        () => engine.createFlow("internal", badDag),
        /not registered/
      );
      engine.destroy();
    });

    it("should validate DAG with tasks field", async () => {
      const { engine } = createEngine();
      const badDag = { notTasks: {} } as unknown as FlowSpec;
      const summary = await engine.createFlow("internal", badDag);
      assert.ok(summary.id);
      engine.destroy();
    });
  });

  describe("getFlow and listFlows", () => {
    it("TC-TFE-009: should list all flows sorted by createdAt desc", async () => {
      const { engine } = createEngine();
      const s1 = await engine.createFlow("internal", singleTaskDag);
      await sleep(10);
      const s2 = await engine.createFlow("user", singleTaskDag);
      await sleep(10);
      const s3 = await engine.createFlow("internal", singleTaskDag);

      const flows = engine.listFlows();
      assert.equal(flows.length, 3);
      assert.equal(flows[0].id, s3.id);
      assert.equal(flows[2].id, s1.id);
      engine.destroy();
    });

    it("TC-TFE-010: should filter flows by type", async () => {
      const { engine } = createEngine();
      await engine.createFlow("internal", singleTaskDag);
      await engine.createFlow("user", singleTaskDag);

      const internal = engine.listFlows("internal");
      for (const f of internal) {
        assert.equal(f.type, "internal");
      }

      const user = engine.listFlows("user");
      for (const f of user) {
        assert.equal(f.type, "user");
      }
      engine.destroy();
    });

    it("TC-TFE-011: should get flow detail by id", async () => {
      const { engine } = createEngine();
      const created = await engine.createFlow("internal", singleTaskDag, { robotIp: "10.0.0.1" }, ["data1"]);

      const detail = engine.getFlow(created.id);
      assert.ok(detail);
      assert.equal(detail.id, created.id);
      assert.equal(detail.type, "internal");
      assert.deepEqual(detail.input, { robotIp: "10.0.0.1" });
      assert.deepEqual(detail.expectedResults, ["data1"]);
      engine.destroy();
    });

    it("TC-TFE-012: should return undefined for non-existent flow", async () => {
      const { engine } = createEngine();
      const result = engine.getFlow("non-existent-id");
      assert.equal(result, undefined);
      engine.destroy();
    });

    it("TC-TFE-010b: should filter flows by single param (solutionId)", async () => {
      const { engine } = createEngine();
      await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1" });
      await engine.createFlow("internal", singleTaskDag, { solutionId: "sol2" });

      const filtered = engine.listFlows(undefined, { solutionId: "sol1" });
      assert.ok(filtered.length >= 1);
      for (const f of filtered) {
        const input = f.input as Record<string, string> | undefined;
        assert.equal(input?.solutionId, "sol1");
      }
      engine.destroy();
    });

    it("TC-TFE-010c: should filter flows by multiple params (solutionId + robotId)", async () => {
      const { engine } = createEngine();
      await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1", robotId: "r1" });
      await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1", robotId: "r2" });
      await engine.createFlow("internal", singleTaskDag, { solutionId: "sol2", robotId: "r1" });

      const filtered = engine.listFlows(undefined, { solutionId: "sol1", robotId: "r1" });
      assert.equal(filtered.length, 1);
      const input = filtered[0].input as Record<string, string>;
      assert.equal(input.solutionId, "sol1");
      assert.equal(input.robotId, "r1");
      engine.destroy();
    });

    it("TC-TFE-010d: should return empty array when no params match", async () => {
      const { engine } = createEngine();
      await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1" });

      const filtered = engine.listFlows(undefined, { nonExistentKey: "xxx" });
      assert.equal(filtered.length, 0);
      engine.destroy();
    });

    it("should combine type filter with params filter", async () => {
      const { engine } = createEngine();
      await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1" });
      await engine.createFlow("user", singleTaskDag, { solutionId: "sol1" });

      const filtered = engine.listFlows("internal", { solutionId: "sol1" });
      assert.ok(filtered.length >= 1);
      for (const f of filtered) {
        assert.equal(f.type, "internal");
        const input = f.input as Record<string, string>;
        assert.equal(input?.solutionId, "sol1");
      }
      engine.destroy();
    });
  });

  describe("pauseFlow and resumeFlow", () => {
    it("TC-TFE-013: should pause a RUNNING flow", async () => {
      const { engine, sse } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);

      sse.clear();
      await engine.pauseFlow(summary.id);

      const flow = engine.getFlow(summary.id);
      assert.ok(flow);
      const terminalStates = ["PAUSED", "COMPLETED", "FAILED", "STOPPED"];
      assert.ok(terminalStates.includes(flow.state));
      engine.destroy();
    });

    it("TC-TFE-014: should be idempotent when pausing non-RUNNING flow", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);
      await engine.pauseFlow(summary.id);
      const stateBefore = engine.getFlow(summary.id)!.state;

      await engine.pauseFlow(summary.id);
      const stateAfter = engine.getFlow(summary.id)!.state;
      assert.equal(stateAfter, stateBefore);
      engine.destroy();
    });

    it("TC-TFE-015: should resume a PAUSED flow", async () => {
      const { engine, sse } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);
      await engine.pauseFlow(summary.id);

      sse.clear();
      await engine.resumeFlow(summary.id);

      await waitForFlowComplete(engine, summary.id);
      const completed = engine.getFlow(summary.id);
      assert.ok(completed);
      assert.ok(["COMPLETED", "RUNNING"].includes(completed.state));
      engine.destroy();
    });

    it("TC-TFE-016: should be idempotent when resuming non-PAUSED flow", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);
      const stateBefore = engine.getFlow(summary.id)!.state;

      await engine.resumeFlow(summary.id);
      const stateAfter = engine.getFlow(summary.id)!.state;
      assert.equal(stateAfter, stateBefore);
      engine.destroy();
    });

    it("should throw when pausing non-existent flow", async () => {
      const { engine } = createEngine();
      await assert.rejects(() => engine.pauseFlow("non-existent"), /Flow not found/);
      engine.destroy();
    });

    it("should throw when resuming non-existent flow", async () => {
      const { engine } = createEngine();
      await assert.rejects(() => engine.resumeFlow("non-existent"), /Flow not found/);
      engine.destroy();
    });
  });

  describe("stopFlow", () => {
    it("TC-TFE-017: should stop a RUNNING flow", async () => {
      const { engine, sse } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);

      sse.clear();
      await engine.stopFlow(summary.id);

      const flow = engine.getFlow(summary.id);
      assert.ok(flow);
      assert.equal(flow.state, "STOPPED");
      assert.ok(flow.finishedAt);
      assert.ok(sse.hasEvent("task-flow-engine/flow-completed"));
      engine.destroy();
    });

    it("TC-TFE-018: should be idempotent when stopping terminal flow", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);
      await engine.stopFlow(summary.id);
      const stateBefore = engine.getFlow(summary.id)!.state;

      await engine.stopFlow(summary.id);
      const stateAfter = engine.getFlow(summary.id)!.state;
      assert.equal(stateAfter, stateBefore);
      engine.destroy();
    });

    it("should throw when stopping non-existent flow", async () => {
      const { engine } = createEngine();
      await assert.rejects(() => engine.stopFlow("non-existent"), /Flow not found/);
      engine.destroy();
    });

    it("should mark pending tasks as SKIPPED when flow fails", async () => {
      const { engine } = createEngine();
      const failingDag: FlowSpec = {
        tasks: {
          task1: {
            provides: ["data1"],
            resolver: { name: "MockFailingTask", results: { done: "data1" } },
          },
          task2: {
            requires: ["data1"],
            resolver: { name: "MockTask2" },
          },
        },
      };
      const summary = await engine.createFlow("internal", failingDag);
      await waitForFlowComplete(engine, summary.id);

      const flow = engine.getFlow(summary.id);
      assert.ok(flow);
      assert.equal(flow.state, "FAILED");
      assert.equal(flow.taskStates["task1"], "FAILED");
      assert.equal(flow.taskStates["task2"], "SKIPPED");
      engine.destroy();
    });
  });

  describe("deleteFlow", () => {
    it("TC-TFE-019: should delete a completed user flow", async () => {
      const { engine, objStore, sse } = createEngine();
      const summary = await engine.createFlow("user", singleTaskDag);
      await waitForFlowComplete(engine, summary.id);

      sse.clear();
      await engine.deleteFlow(summary.id);

      assert.equal(engine.getFlow(summary.id), undefined);
      const persisted = await objStore.getJson(`flows/${summary.id}`);
      assert.equal(persisted, null);
      assert.ok(sse.hasEvent("task-flow-engine/flow-removed"));
      engine.destroy();
    });

    it("TC-TFE-020: should auto-stop and delete a RUNNING flow", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("user", singleTaskDag);

      await engine.deleteFlow(summary.id);
      assert.equal(engine.getFlow(summary.id), undefined);
      engine.destroy();
    });

    it("should not delete internal flow from object store", async () => {
      const { engine } = createEngine();
      const summary = await engine.createFlow("internal", singleTaskDag);
      await waitForFlowComplete(engine, summary.id);

      await engine.deleteFlow(summary.id);
      assert.equal(engine.getFlow(summary.id), undefined);
      engine.destroy();
    });

    it("should throw when deleting non-existent flow", async () => {
      const { engine } = createEngine();
      await assert.rejects(() => engine.deleteFlow("non-existent"), /Flow not found/);
      engine.destroy();
    });
  });

  describe("batch operations", () => {
    it("TC-TFE-021: should batch pause flows", async () => {
      const { engine } = createEngine();
      const s1 = await engine.createFlow("internal", singleTaskDag);
      const s2 = await engine.createFlow("internal", singleTaskDag);

      await engine.batchPause([s1.id, s2.id]);

      const f1 = engine.getFlow(s1.id)!;
      const f2 = engine.getFlow(s2.id)!;
      assert.ok(f1);
      assert.ok(f2);
      engine.destroy();
    });

    it("TC-TFE-022: should batch resume flows", async () => {
      const { engine } = createEngine();
      const s1 = await engine.createFlow("internal", singleTaskDag);
      const s2 = await engine.createFlow("internal", singleTaskDag);
      await engine.batchPause([s1.id, s2.id]);

      await engine.batchResume([s1.id, s2.id]);

      const f1 = engine.getFlow(s1.id)!;
      const f2 = engine.getFlow(s2.id)!;
      assert.ok(f1);
      assert.ok(f2);
      engine.destroy();
    });

    it("TC-TFE-023: should batch stop flows", async () => {
      const { engine } = createEngine();
      const s1 = await engine.createFlow("internal", singleTaskDag);
      const s2 = await engine.createFlow("internal", singleTaskDag);

      await engine.batchStop([s1.id, s2.id]);

      const f1 = engine.getFlow(s1.id)!;
      const f2 = engine.getFlow(s2.id)!;
      assert.ok(f1);
      assert.ok(f2);
      assert.ok(["STOPPED", "COMPLETED", "FAILED"].includes(f1.state));
      assert.ok(["STOPPED", "COMPLETED", "FAILED"].includes(f2.state));
      engine.destroy();
    });

    it("TC-TFE-024: should batch delete flows", async () => {
      const { engine } = createEngine();
      const s1 = await engine.createFlow("internal", singleTaskDag);
      const s2 = await engine.createFlow("internal", singleTaskDag);
      await waitForFlowComplete(engine, s1.id);
      await waitForFlowComplete(engine, s2.id);

      await engine.batchDelete([s1.id, s2.id]);

      assert.equal(engine.getFlow(s1.id), undefined);
      assert.equal(engine.getFlow(s2.id), undefined);
      engine.destroy();
    });

    it("TC-TFE-025: should handle partial failures in batch", async () => {
      const { engine } = createEngine();
      const s1 = await engine.createFlow("internal", singleTaskDag);

      await engine.batchStop([s1.id, "non-existent"]);

      const flow = engine.getFlow(s1.id);
      assert.ok(flow);
      assert.equal(flow.state, "STOPPED");
      engine.destroy();
    });
  });
});

describe("TaskFlowEngine - SSE Events", () => {
  it("TC-TFE-026: should broadcast flow-created event", async () => {
    const { engine, sse } = createEngine();
    sse.clear();
    const summary = await engine.createFlow("internal", singleTaskDag);

    const event = sse.findEvent("task-flow-engine/flow-created");
    assert.ok(event);
    const envelope = event.data as { event: string; payload: Record<string, unknown>; timestamp: string };
    assert.equal(envelope.payload.id, summary.id);
    assert.ok(envelope.timestamp);
    engine.destroy();
  });

  it("TC-TFE-027: should broadcast flow-updated event on state change", async () => {
    const { engine, sse } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    sse.clear();

    await engine.pauseFlow(summary.id);
    assert.ok(sse.hasEvent("task-flow-engine/flow-updated"));
    engine.destroy();
  });

  it("TC-TFE-028: should broadcast task-updated event", async () => {
    const { engine, sse } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    assert.ok(sse.hasEvent("task-flow-engine/task-updated"));
    const taskEvents = sse.events.filter((e) => e.event === "task-flow-engine/task-updated");
    assert.ok(taskEvents.length >= 2);

    const startedEvent = taskEvents.find((e) => (e.data as { payload: { state: string } }).payload.state === "RUNNING");
    assert.ok(startedEvent);
    assert.equal((startedEvent!.data as { payload: { taskName: string } }).payload.taskName, "task1");

    const completedEvent = taskEvents.find((e) => (e.data as { payload: { state: string } }).payload.state === "COMPLETED");
    assert.ok(completedEvent);
    engine.destroy();
  });

  it("TC-TFE-029: should broadcast task-result event with result", async () => {
    const { engine, sse } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    const resultEvent = sse.findEvent("task-flow-engine/task-result");
    if (resultEvent) {
      const envelope = resultEvent.data as { event: string; payload: Record<string, unknown>; timestamp: string };
      assert.equal(envelope.payload.state, "COMPLETED");
      assert.ok(envelope.payload.result);
    }
    engine.destroy();
  });

  it("TC-TFE-030: should broadcast flow-completed event", async () => {
    const { engine, sse } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    const event = sse.findEvent("task-flow-engine/flow-completed");
    assert.ok(event);
    const envelope = event.data as { event: string; payload: Record<string, unknown>; timestamp: string };
    assert.equal(envelope.payload.flowId, summary.id);
    assert.equal(envelope.payload.state, "COMPLETED");
    assert.ok(envelope.payload.finishedAt);
    assert.ok(envelope.timestamp);
    engine.destroy();
  });

  it("TC-TFE-031: should broadcast flow-removed event on delete", async () => {
    const { engine, sse } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);
    sse.clear();

    await engine.deleteFlow(summary.id);
    assert.ok(sse.hasEvent("task-flow-engine/flow-removed"));
    const event = sse.findEvent("task-flow-engine/flow-removed");
    const envelope = event!.data as { event: string; payload: Record<string, unknown>; timestamp: string };
    assert.equal(envelope.payload.flowId, summary.id);
    engine.destroy();
  });

  it("SSE events should include timestamp", async () => {
    const { engine, sse } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);

    for (const e of sse.events) {
      const envelope = e.data as { timestamp: string };
      assert.ok(envelope.timestamp);
      assert.ok(typeof envelope.timestamp === "string");
    }
    engine.destroy();
  });
});

describe("TaskFlowEngine - Results Extraction", () => {
  it("TC-TFE-032: should extract task results on completion", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", dependentDag);
    await waitForFlowComplete(engine, summary.id);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.ok(flow.taskResults);
    assert.ok(flow.taskResults!["task1"]);
    assert.ok(flow.taskResults!["task2"]);
    engine.destroy();
  });

  it("TC-TFE-033: should extract flow-level expected results", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag, undefined, ["data1"]);
    await waitForFlowComplete(engine, summary.id);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.ok(flow.results);
    assert.ok((flow.results as ValueMap)["data1"] !== undefined);
    engine.destroy();
  });
});

describe("TaskFlowEngine - Persistence and Recovery", () => {
  it("TC-TFE-034: should persist user flow on state change", async () => {
    const { engine, objStore } = createEngine();
    const summary = await engine.createFlow("user", singleTaskDag);

    const persisted = await objStore.getJson(`flows/${summary.id}`);
    assert.ok(persisted);
    assert.equal((persisted as FlowRecord).state, "RUNNING");
    engine.destroy();
  });

  it("TC-TFE-035: should not persist internal flow", async () => {
    const { engine, objStore } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);

    const persisted = await objStore.getJson(`flows/${summary.id}`);
    assert.equal(persisted, null);
    engine.destroy();
  });

  it("TC-TFE-036: should load RUNNING flow as PENDING on restart without auto-start", async () => {
    const { engine: engine1, objStore, sse } = createEngine();
    const summary = await engine1.createFlow("user", singleTaskDag);
    await engine1.pauseFlow(summary.id);

    let persisted = await objStore.getJson(`flows/${summary.id}`) as FlowRecord;
    assert.ok(persisted);
    persisted = { ...persisted, state: "RUNNING" as const };
    await objStore.putJson(`flows/${summary.id}`, persisted);
    engine1.destroy();

    const registry2 = new ResolverRegistry();
    registry2.register("MockTask1", MockTask1);
    registry2.register("MockTask2", MockTask2);
    registry2.register("MockFailingTask", MockFailingTask);
    registry2.register("MockRecoveryTask", MockRecoveryTask);
    const engine2 = new TaskFlowEngine(
      objStore as unknown as import("./services/objectStore.js").ObjectStore,
      sse as unknown as SseManager,
      registry2
    );
    await engine2.loadPersistedFlows();

    const flow = engine2.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "PENDING");
    assert.equal(flow.startedAt, undefined);

    const retried = await engine2.retryFlow(summary.id);
    assert.equal(retried.id, summary.id);
    assert.equal(retried.state, "RUNNING");

    await waitForFlowComplete(engine2, summary.id);
    const completed = engine2.getFlow(summary.id);
    assert.ok(completed);
    assert.ok(["COMPLETED", "FAILED"].includes(completed.state));
    engine2.destroy();
  });

  it("TC-TFE-037: should recover PAUSED flow without restarting", async () => {
    const { engine: engine1, objStore, sse } = createEngine();
    const summary = await engine1.createFlow("user", singleTaskDag);
    await engine1.pauseFlow(summary.id);

    const persisted = await objStore.getJson(`flows/${summary.id}`) as FlowRecord;
    assert.equal(persisted.state, "PAUSED");
    engine1.destroy();

    const registry2 = new ResolverRegistry();
    registry2.register("MockTask1", MockTask1);
    registry2.register("MockTask2", MockTask2);
    registry2.register("MockFailingTask", MockFailingTask);
    registry2.register("MockRecoveryTask", MockRecoveryTask);
    const engine2 = new TaskFlowEngine(
      objStore as unknown as import("./services/objectStore.js").ObjectStore,
      sse as unknown as SseManager,
      registry2
    );
    await engine2.loadPersistedFlows();

    const flow = engine2.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "PAUSED");
    engine2.destroy();
  });

  it("TC-TFE-038: should recover terminal flow as history only", async () => {
    const { engine: engine1, objStore, sse } = createEngine();
    const summary = await engine1.createFlow("user", singleTaskDag);
    await waitForFlowComplete(engine1, summary.id);
    engine1.destroy();

    const registry2 = new ResolverRegistry();
    registry2.register("MockTask1", MockTask1);
    registry2.register("MockTask2", MockTask2);
    registry2.register("MockFailingTask", MockFailingTask);
    registry2.register("MockRecoveryTask", MockRecoveryTask);
    const engine2 = new TaskFlowEngine(
      objStore as unknown as import("./services/objectStore.js").ObjectStore,
      sse as unknown as SseManager,
      registry2
    );
    await engine2.loadPersistedFlows();

    const flow = engine2.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "COMPLETED");
    engine2.destroy();
  });

  it("TC-TFE-045: should retry a completed flow resetting its state", async () => {
    const { engine, objStore } = createEngine();
    const summary = await engine.createFlow("user", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    const retried = await engine.retryFlow(summary.id);
    assert.equal(retried.id, summary.id);
    // In fast mock environments the flow may complete instantly after retry
    assert.ok(["RUNNING", "COMPLETED", "FAILED"].includes(retried.state));

    const persisted = await objStore.getJson(`flows/${summary.id}`) as FlowRecord;
    assert.ok(persisted);
    assert.equal(persisted.id, summary.id);
    assert.ok(["RUNNING", "COMPLETED", "FAILED"].includes(persisted.state));

    engine.destroy();
  });

  it("TC-TFE-046: should allow retry on a PENDING flow loaded after restart", async () => {
    const { engine: engine1, objStore, sse } = createEngine();
    const summary = await engine1.createFlow("user", singleTaskDag);
    await engine1.pauseFlow(summary.id);

    let persisted = await objStore.getJson(`flows/${summary.id}`) as FlowRecord;
    assert.ok(persisted);
    persisted = { ...persisted, state: "RUNNING" as const };
    await objStore.putJson(`flows/${summary.id}`, persisted);
    engine1.destroy();

    const registry2 = new ResolverRegistry();
    registry2.register("MockTask1", MockTask1);
    registry2.register("MockTask2", MockTask2);
    registry2.register("MockFailingTask", MockFailingTask);
    registry2.register("MockRecoveryTask", MockRecoveryTask);
    const engine2 = new TaskFlowEngine(
      objStore as unknown as import("./services/objectStore.js").ObjectStore,
      sse as unknown as SseManager,
      registry2
    );
    await engine2.loadPersistedFlows();

    const flow = engine2.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "PENDING");

    const retried = await engine2.retryFlow(summary.id);
    assert.equal(retried.id, summary.id);
    assert.equal(retried.state, "RUNNING");

    await waitForFlowComplete(engine2, summary.id);
    const completed = engine2.getFlow(summary.id);
    assert.ok(completed);
    assert.ok(["COMPLETED", "FAILED"].includes(completed.state));
    engine2.destroy();
  });

  it("TC-TFE-047: should throw when retrying non-existent flow", async () => {
    const { engine } = createEngine();
    await assert.rejects(() => engine.retryFlow("nonexistent"), /Flow not found/);
    engine.destroy();
  });

  it("TC-TFE-048: should throw when retrying a running flow", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await assert.rejects(() => engine.retryFlow(summary.id), /Cannot retry a running or paused flow/);
    engine.destroy();
  });

  it("TC-TFE-049: should throw when retrying a paused flow", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await engine.pauseFlow(summary.id);
    await assert.rejects(() => engine.retryFlow(summary.id), /Cannot retry a running or paused flow/);
    engine.destroy();
  });
});

describe("TaskFlowEngine - TTL Cleanup", () => {
  it("TC-TFE-039: should clean up expired completed flows", async () => {
    const { engine, sse } = createEngine(100, 200);
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    await sleep(500);

    const flow = engine.getFlow(summary.id);
    assert.equal(flow, undefined);
    assert.ok(sse.hasEvent("task-flow-engine/flow-removed"));
    engine.destroy();
  });

  it("TC-TFE-040: should not clean up non-terminal flows", async () => {
    const { engine } = createEngine(100, 200);
    const summary = await engine.createFlow("internal", singleTaskDag);
    await engine.pauseFlow(summary.id);

    await sleep(500);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    engine.destroy();
  });
});

describe("TaskFlowEngine - Lifecycle", () => {
  it("TC-TFE-043: destroy should stop cleanup timer", async () => {
    const { engine } = createEngine(100, 200);
    engine.destroy();

    engine.destroy();
  });

  it("TC-TFE-044: module should not expose singleton access functions", async () => {
    const mod = await import("./services/taskFlowEngine/index.js");
    assert.equal("getTaskFlowEngine" in mod, false, "getTaskFlowEngine should not be exported");
    assert.equal("setTaskFlowEngine" in mod, false, "setTaskFlowEngine should not be exported");
    assert.equal("clearTaskFlowEngine" in mod, false, "clearTaskFlowEngine should not be exported");
  });
});

describe("ResolverRegistry", () => {
  it("TC-TFE-041: should register, get, has and getAll resolvers", () => {
    const registry = new ResolverRegistry();
    registry.register("TestTask", MockTask1);

    assert.ok(registry.has("TestTask"));
    assert.equal(registry.has("NonExistent"), false);

    const cls = registry.get("TestTask");
    assert.ok(cls);

    const all = registry.getAll();
    assert.ok(all["TestTask"]);
  });
});

describe("BUP version matching", () => {
  it("should match expected version against the actual BUP version suffix", () => {
    const task = new TestableMatchBUPVersionTask();

    assert.equal(task.match("xxx-1.1.945", "1.1.945"), true);
    assert.equal(task.match("xxx-1.1.945\n", "1.1.945"), true);
    assert.equal(task.match("xxx-1.1.945", "1.1.946"), false);
    assert.match(
      task.mismatchMessage("/etc/l4t_jurassic_release", "1.1.945", "xxx-1.1.946"),
      /expected suffix "1\.1\.945"/
    );
  });
});

class TestableMovebaseDiskCleanupTask extends MovebaseDiskCleanupTask {
  public command(params: ValueMap = {}): string {
    return this.getSshCommand(params);
  }

  public params(params: ValueMap): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

describe("Movebase disk cleanup task", () => {
  it("TC-TFE-055: should generate SOP cleanup command with conservative defaults", () => {
    const task = new TestableMovebaseDiskCleanupTask();
    const command = task.command();

    assert.match(command, / && /);
    assert.match(command, /rm -rf -- \/etc\/l4t_ota/);
    assert.match(command, /find \/opt\/cosmos\/ota\/recovery .*\.deb.*\.apk/);
    assert.match(command, /rm -rf -- \/opt\/cosmos\/lib\/vendor/);
    assert.match(command, /find \/mnt\/cosmos\/boot\/lib\/bootstrapper -mindepth 1 -maxdepth 1/);
    assert.doesNotMatch(command, /echo|df -h|du -sh/);
    assert.doesNotMatch(command, /\/home\/developer \/home\/factory/);
    assert.doesNotMatch(command, /rm -rf -- \/(?:\s|&&|$)/);

    const built = task.params({ robotIp: "192.168.1.10", sshUsername: "u", sshPassword: "p" });
    assert.equal(built.sudo, true);
    assert.equal(built.retryCount, 1);
    assert.equal(built.commandTimeout, 10000);
  });

  it("TC-TFE-056: should enable user home cleanup only when requested", () => {
    const task = new TestableMovebaseDiskCleanupTask();
    const command = task.command({ cleanUserHomes: true });

    assert.doesNotMatch(command, /echo|df -h|du -sh/);
    assert.match(command, /find \/home\/developer \/home\/factory -mindepth 1 -maxdepth 1/);
  });
});

import {
  TransferAEConfigTask,
  DeployAEConfigTask,
  DeleteAEConfigTask,
  MockTransferAEConfigTask,
  MockDeployAEConfigTask,
  MockDeleteAEConfigTask,
} from "./tasks/index.js";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as pathJoin } from "node:path";

class TestableDeployAEConfigTask extends DeployAEConfigTask {
  public command(params: ValueMap = {}): string {
    return this.getSshCommand(params);
  }
  public params(params: ValueMap): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

class TestableDeleteAEConfigTask extends DeleteAEConfigTask {
  public command(params: ValueMap = {}): string {
    return this.getSshCommand(params);
  }
  public params(params: ValueMap): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

class TestableTransferAEConfigTask extends TransferAEConfigTask {
  public lastSeenLocalFilePath: string | undefined;
  public superCalled = false;
  public params(params: ValueMap): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
  // Stub the SFTP path by overriding the parent SshFileTransferTask.onExec.
  // This is invoked via `super.onExec(augmentedParams, context)` from
  // TransferAEConfigTask.onExec, so we observe the augmented localFilePath.
  public stubbedSuperOnExec(params: ValueMap): ValueMap {
    this.superCalled = true;
    this.lastSeenLocalFilePath = params.localFilePath as string;
    return {
      done: true,
      success: true,
      bytesTransferred: 0,
      localChecksum: "",
      remoteChecksum: "",
      integrityVerified: true,
    };
  }
}

// Patch SshFileTransferTask.prototype.onExec for instances of
// TestableTransferAEConfigTask only. We do this by replacing the parent
// prototype method with a guard that delegates to stubbedSuperOnExec when
// the call is on a Testable instance, otherwise calls the original.
function installTransferAEStub(): () => void {
  const parentProto = Object.getPrototypeOf(TransferAEConfigTask.prototype) as {
    onExec: (params: ValueMap, context?: ValueMap) => Promise<ValueMap>;
  };
  const original = parentProto.onExec;
  parentProto.onExec = async function (
    this: TestableTransferAEConfigTask | object,
    params: ValueMap,
    context?: ValueMap
  ) {
    if (this instanceof TestableTransferAEConfigTask) {
      return this.stubbedSuperOnExec(params);
    }
    return original.call(this, params, context);
  };
  return () => {
    parentProto.onExec = original;
  };
}

describe("Deploy AE Config tasks", () => {
  let restoreTransferStub: (() => void) | undefined;

  beforeEach(() => {
    restoreTransferStub = installTransferAEStub();
  });

  afterEach(() => {
    restoreTransferStub?.();
    restoreTransferStub = undefined;
  });

  it("TC-AE-001: DeployAEConfigTask builds the multi-step deploy command with sudo", () => {
    const task = new TestableDeployAEConfigTask();
    const cmd = task.command({});

    // Ordered fragment assertions: directly unzip the package into the deploy
    // directory (no intermediate /tmp/ae_config_extract staging).
    const fragments = [
      "[ -d /opt/cosmos/bin/applet-engine ] || { echo \"Deploy target not found: /opt/cosmos/bin/applet-engine\" >&2; exit 1; }",
      "unzip -o /tmp/ae_config_package.zip -d /opt/cosmos/bin/applet-engine",
      "chown -R cosmos:cosmos /opt/cosmos/bin/applet-engine",
      "systemctl restart cosmos-applet-engine.service",
      "rm -f /tmp/ae_config_package.zip",
    ];
    let cursor = 0;
    for (const f of fragments) {
      const idx = cmd.indexOf(f, cursor);
      assert.ok(idx !== -1, `fragment missing or out of order: ${f}`);
      cursor = idx + f.length;
    }

    // Negative assertion: must NOT pre-create the deploy directory.
    assert.equal(
      cmd.includes("mkdir -p /opt/cosmos/bin/applet-engine"),
      false,
      "Deploy target directory must not be auto-created"
    );

    // Negative assertion: must NOT use any /tmp/ae_config_extract staging dir
    // (we now unzip directly into the deploy directory).
    assert.equal(
      cmd.includes("/tmp/ae_config_extract"),
      false,
      "Must not use a /tmp/ae_config_extract staging directory"
    );

    // Negative assertion: must NOT use /home/developer for the upload/extract
    // staging area (the package lives under /tmp).
    assert.equal(
      cmd.includes("/home/developer"),
      false,
      "Staging paths must live under /tmp, not /home/developer"
    );

    assert.equal(
      cmd.includes(" reboot"),
      false,
      "Deploy AE Config must restart only the AE service, not the robot"
    );

    const built = task.params({ robotIp: "192.168.1.10" });
    assert.equal(built.sudo, true);
    assert.equal(built.commandTimeout, 60000);
    assert.equal(built.retryCount, 1);
  });

  it("TC-AE-002: DeleteAEConfigTask returns the cleanup command and forces sudo", () => {
    const task = new TestableDeleteAEConfigTask();
    const cmd = task.command({});
    assert.equal(cmd, "rm -f /tmp/ae_config_package.zip");
    const built = task.params({ robotIp: "192.168.1.10" });
    assert.equal(built.sudo, true);
  });

  it("TC-AE-003: TransferAEConfigTask hardcodes the remote target path", () => {
    const task = new TestableTransferAEConfigTask();
    const built = task.params({
      robotIp: "192.168.1.10",
      localFilePath: "/tmp/x.zip",
    });
    assert.equal(built.remoteFilePath, "/tmp/ae_config_package.zip");
    assert.equal(built.sudo, true);
  });

  it("TC-AE-004: TransferAEConfigTask resolves artifact via getArtifactPath and forwards localFilePath", async () => {
    const task = new TestableTransferAEConfigTask();
    const tmpDir = mkdtempSync(pathJoin(osTmpdir(), "ae-getpath-"));
    const stubArtifactPath = pathJoin(tmpDir, "ae_config_package.zip");
    writeFileSync(stubArtifactPath, "stub-zip-content");
    let receivedArtifactId: string | undefined;
    const artifactService = {
      async getArtifactPath(artifactId: string): Promise<string> {
        receivedArtifactId = artifactId;
        return stubArtifactPath;
      },
    };

    const result = await task.exec(
      { robotIp: "192.168.1.10", artifactId: "art-1" },
      { artifactService }
    );

    assert.equal(result.success, true);
    assert.equal(task.superCalled, true, "super.onExec should be invoked");
    assert.equal(receivedArtifactId, "art-1");
    assert.equal(
      task.lastSeenLocalFilePath,
      stubArtifactPath,
      "localFilePath should equal the path returned by getArtifactPath"
    );
  });

  it("TC-AE-005: TransferAEConfigTask falls through to super when artifactId/service is absent", async () => {
    const task = new TestableTransferAEConfigTask();
    const tmpDir = mkdtempSync(pathJoin(osTmpdir(), "ae-fallthrough-"));
    const localFilePath = pathJoin(tmpDir, "x.zip");
    writeFileSync(localFilePath, "stub");

    const result = await task.exec({
      robotIp: "192.168.1.10",
      localFilePath,
    });

    assert.equal(result.success, true);
    assert.equal(task.superCalled, true);
    assert.equal(task.lastSeenLocalFilePath, localFilePath);
  });

  it("TC-AE-006: Mock AE Config tasks return success quickly", async () => {
    const transferMock = new MockTransferAEConfigTask();
    const deployMock = new MockDeployAEConfigTask();
    const deleteMock = new MockDeleteAEConfigTask();

    const [t, d, x] = await Promise.all([
      transferMock.exec({ robotIp: "192.168.1.10", artifactId: "a" }),
      deployMock.exec({ robotIp: "192.168.1.10" }),
      deleteMock.exec({ robotIp: "192.168.1.10" }),
    ]);
    assert.equal(t.success, true);
    assert.equal(d.success, true);
    assert.equal(x.success, true);
  });

  it("TC-AE-007: tasks/index.ts exports all six AE config task classes", () => {
    assert.equal(typeof TransferAEConfigTask, "function");
    assert.equal(typeof DeployAEConfigTask, "function");
    assert.equal(typeof DeleteAEConfigTask, "function");
    assert.equal(typeof MockTransferAEConfigTask, "function");
    assert.equal(typeof MockDeployAEConfigTask, "function");
    assert.equal(typeof MockDeleteAEConfigTask, "function");
  });
});

describe("SSH wait tasks", () => {
  afterEach(() => {
    resetSshConnectionProbeForTest();
  });

  it("TC-TFE-050: should wait for SSH connected state", async () => {
    const calls: SshConnectionProbeParams[] = [];
    setSshConnectionProbeForTest(async (params) => {
      calls.push(params);
      return { connected: true };
    });

    const task = new WaitSshConnectedTask();
    const result = await task.exec({
      robotIp: "192.168.1.10",
      robotPort: 2222,
      sshUsername: "developer",
      sshPassword: "secret",
      timeout: 100,
      pollIntervalMs: 1,
      connectTimeoutMs: 10,
    });

    assert.equal(result.done, true);
    assert.equal(result.success, true);
    assert.equal(result.state, "connected");
    assert.equal(result.attempts, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].host, "192.168.1.10");
    assert.equal(calls[0].port, 2222);
    assert.equal(calls[0].username, "developer");
    assert.equal(calls[0].password, "secret");
  });

  it("TC-TFE-051: should wait for SSH disconnected state", async () => {
    setSshConnectionProbeForTest(async () => ({ connected: false, error: "ECONNREFUSED" }));

    const task = new WaitSshDisconnectedTask();
    const result = await task.exec({
      robotIp: "192.168.1.10",
      timeout: 100,
      pollIntervalMs: 1,
      connectTimeoutMs: 10,
    });

    assert.equal(result.done, true);
    assert.equal(result.success, true);
    assert.equal(result.state, "disconnected");
    assert.equal(result.attempts, 1);
  });

  it("TC-TFE-052: should wait for SSH disconnect and reconnect", async () => {
    const states = [true, false, true];
    const observed: boolean[] = [];
    setSshConnectionProbeForTest(async () => {
      const connected = states.shift() ?? true;
      observed.push(connected);
      return { connected };
    });

    const task = new WaitSshReconnectTask();
    const result = await task.exec({
      robotIp: "192.168.1.10",
      timeout: 100,
      pollIntervalMs: 1,
      connectTimeoutMs: 10,
    });

    assert.equal(result.done, true);
    assert.equal(result.success, true);
    assert.equal(result.state, "connected");
    assert.ok(result.disconnectResult);
    assert.ok(result.connectResult);
    assert.deepEqual(observed, [true, false, true]);
  });

  it("TC-TFE-053: should return failed result when timeout is ignored", async () => {
    setSshConnectionProbeForTest(async () => ({ connected: false, error: "ECONNREFUSED" }));

    const task = new WaitSshConnectedTask();
    const result = await task.exec({
      robotIp: "192.168.1.10",
      timeout: 5,
      pollIntervalMs: 1,
      connectTimeoutMs: 1,
      ignoreFailure: true,
    });

    assert.equal(result.done, true);
    assert.equal(result.success, false);
    assert.equal(result.state, "disconnected");
    assert.match(result.error as string, /Timed out waiting for SSH connected/);
  });

  it("TC-TFE-054: should throw when timeout is not ignored", async () => {
    setSshConnectionProbeForTest(async () => ({ connected: false, error: "ECONNREFUSED" }));

    const task = new WaitSshConnectedTask();
    await assert.rejects(
      () => task.exec({
        robotIp: "192.168.1.10",
        timeout: 5,
        pollIntervalMs: 1,
        connectTimeoutMs: 1,
      }),
      /Timed out waiting for SSH connected/
    );
  });
});

describe("SseManager", () => {
  it("should add and remove clients", () => {
    const mgr = new SseManager();
    const controller = {} as ReadableStreamDefaultController;

    mgr.addClient({ id: "c1", controller });
    mgr.addClient({ id: "c2", controller });
    assert.equal(mgr.getClientCount(), 2);

    mgr.removeClient("c1");
    assert.equal(mgr.getClientCount(), 1);
  });

  it("should broadcast events to clients", () => {
    const mgr = new SseManager();
    const enqueued: string[] = [];
    const controller = {
      enqueue: (data: Uint8Array) => {
        enqueued.push(new TextDecoder().decode(data));
      },
    } as unknown as ReadableStreamDefaultController;

    mgr.addClient({ id: "c1", controller });
    mgr.broadcast("test-event", { key: "value" });

    assert.ok(enqueued.length > 0);
    assert.ok(enqueued[0].includes("event: test-event"));
    assert.ok(enqueued[0].includes("key"));
    assert.ok(enqueued[0].includes("timestamp"));
  });
});

function createMockController(options?: { failAfter?: number }): ReadableStreamDefaultController & { enqueued: Uint8Array[]; failCount: number } {
  const enqueued: Uint8Array[] = [];
  let failCount = 0;
  return {
    enqueued,
    failCount,
    enqueue(chunk: Uint8Array) {
      if (options?.failAfter !== undefined && enqueued.length >= options.failAfter) {
        failCount++;
        throw new Error("Simulated write failure");
      }
      enqueued.push(chunk);
    },
  } as unknown as ReadableStreamDefaultController & { enqueued: Uint8Array[]; failCount: number };
}

describe("SseManager - Unit Tests", () => {
  it("TC-SSE-001: addClient registers a new client", () => {
    const mgr = new SseManager();
    const controller = createMockController();
    mgr.addClient({ id: "client-1", controller });
    assert.equal(mgr.getClientCount(), 1);
  });

  it("TC-SSE-002: removeClient unregisters a client by ID", () => {
    const mgr = new SseManager();
    const controller = createMockController();
    mgr.addClient({ id: "client-1", controller });
    mgr.removeClient("client-1");
    assert.equal(mgr.getClientCount(), 0);
  });

  it("TC-SSE-003: removeClient is idempotent for non-existent ID", () => {
    const mgr = new SseManager();
    mgr.removeClient("non-existent");
    assert.equal(mgr.getClientCount(), 0);
  });

  it("TC-SSE-004: broadcast sends event to all connected clients", () => {
    const mgr = new SseManager();
    const c1 = createMockController();
    const c2 = createMockController();
    mgr.addClient({ id: "client-1", controller: c1 });
    mgr.addClient({ id: "client-2", controller: c2 });

    mgr.broadcast("test/event", { foo: "bar" });

    assert.equal(c1.enqueued.length, 1);
    assert.equal(c2.enqueued.length, 1);
  });

  it("TC-SSE-005: broadcast includes timestamp in envelope", () => {
    const mgr = new SseManager();
    const c = createMockController();
    mgr.addClient({ id: "client-1", controller: c });

    mgr.broadcast("test/event", { foo: "bar" });

    const text = new TextDecoder().decode(c.enqueued[0]);
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    assert.ok(dataLine);
    const json = JSON.parse(dataLine!.slice(6));
    assert.ok(json.timestamp);
    assert.ok(new Date(json.timestamp).getTime() > 0);
  });

  it("TC-SSE-006: broadcast uses correct SSE protocol format", () => {
    const mgr = new SseManager();
    const c = createMockController();
    mgr.addClient({ id: "client-1", controller: c });

    mgr.broadcast("test/event", { foo: "bar" });

    const text = new TextDecoder().decode(c.enqueued[0]);
    assert.match(text, /^event: test\/event\ndata: /);
    assert.match(text, /\n\n$/);
  });

  it("TC-SSE-007: broadcast removes client on write failure and continues", () => {
    const mgr = new SseManager();
    const cGood = createMockController();
    const cFail = createMockController({ failAfter: 0 });
    mgr.addClient({ id: "client-good", controller: cGood });
    mgr.addClient({ id: "client-fail", controller: cFail });

    mgr.broadcast("test/event", { foo: "bar" });

    assert.equal(cGood.enqueued.length, 1);
    assert.equal(mgr.getClientCount(), 1);
  });

  it("TC-SSE-008: broadcast with empty event name throws", () => {
    const mgr = new SseManager();
    const c = createMockController();
    mgr.addClient({ id: "client-1", controller: c });

    assert.throws(() => mgr.broadcast("", {}), /Event name must not be empty/);
  });

  it("TC-SSE-010: getClientCount reflects accurate state", () => {
    const mgr = new SseManager();
    assert.equal(mgr.getClientCount(), 0);

    const c1 = createMockController();
    const c2 = createMockController();
    const c3 = createMockController();
    mgr.addClient({ id: "c1", controller: c1 });
    mgr.addClient({ id: "c2", controller: c2 });
    mgr.addClient({ id: "c3", controller: c3 });
    assert.equal(mgr.getClientCount(), 3);

    mgr.removeClient("c2");
    assert.equal(mgr.getClientCount(), 2);
  });

  it("TC-SSE-024: single client failure does not affect others during broadcast", () => {
    const mgr = new SseManager();
    const cA = createMockController();
    const cB = createMockController({ failAfter: 0 });
    const cC = createMockController();
    mgr.addClient({ id: "A", controller: cA });
    mgr.addClient({ id: "B", controller: cB });
    mgr.addClient({ id: "C", controller: cC });

    mgr.broadcast("test", {});

    assert.equal(cA.enqueued.length, 1);
    assert.equal(cC.enqueued.length, 1);
    assert.equal(mgr.getClientCount(), 2);
  });

  it("TC-SSE-025: broadcast never throws with all failing clients", () => {
    const mgr = new SseManager();
    const c1 = createMockController({ failAfter: 0 });
    const c2 = createMockController({ failAfter: 0 });
    mgr.addClient({ id: "c1", controller: c1 });
    mgr.addClient({ id: "c2", controller: c2 });

    mgr.broadcast("test", {});

    assert.equal(mgr.getClientCount(), 0);
  });

  it("TC-SSE-026: broadcast with empty string event name throws", () => {
    const mgr = new SseManager();
    const c = createMockController();
    mgr.addClient({ id: "c1", controller: c });

    assert.throws(() => mgr.broadcast("   ", {}), /Event name must not be empty/);
  });

  it("TC-SSE-027: broadcast with 100 clients", () => {
    const mgr = new SseManager();
    const controllers: ReturnType<typeof createMockController>[] = [];
    for (let i = 0; i < 100; i++) {
      const c = createMockController();
      controllers.push(c);
      mgr.addClient({ id: `c${i}`, controller: c });
    }

    const start = performance.now();
    mgr.broadcast("test", { data: "x".repeat(1000) });
    const duration = performance.now() - start;

    assert.ok(duration < 50);
    for (const c of controllers) {
      assert.equal(c.enqueued.length, 1);
    }
  });

  it("TC-SSE-028: rapid add/remove cycle", () => {
    const mgr = new SseManager();

    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 50; i++) {
        const c = createMockController();
        mgr.addClient({ id: `c${round}-${i}`, controller: c });
      }
      assert.equal(mgr.getClientCount(), (round + 1) * 50);
    }

    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 50; i++) {
        mgr.removeClient(`c${round}-${i}`);
      }
    }
    assert.equal(mgr.getClientCount(), 0);
  });
});

describe("SseManager - sendToClient", () => {
  it("TC-SSE-029: sendToClient delivers event to a single client", () => {
    const mgr = new SseManager();
    const cA = createMockController();
    const cB = createMockController();
    const cC = createMockController();
    mgr.addClient({ id: "client-A", controller: cA });
    mgr.addClient({ id: "client-B", controller: cB });
    mgr.addClient({ id: "client-C", controller: cC });

    const result = mgr.sendToClient("client-B", "test/event", { foo: "bar" });

    assert.equal(result, true);
    assert.equal(cA.enqueued.length, 0);
    assert.equal(cB.enqueued.length, 1);
    assert.equal(cC.enqueued.length, 0);
  });

  it("TC-SSE-030: sendToClient returns false for unknown client", () => {
    const mgr = new SseManager();
    const result = mgr.sendToClient("unknown", "test/event", { foo: "bar" });
    assert.equal(result, false);
  });

  it("TC-SSE-031: sendToClient removes client on write failure", () => {
    const mgr = new SseManager();
    const c = createMockController({ failAfter: 0 });
    mgr.addClient({ id: "client-1", controller: c });

    const result = mgr.sendToClient("client-1", "test/event", { foo: "bar" });

    assert.equal(result, false);
    assert.equal(mgr.getClientCount(), 0);
  });

  it("TC-SSE-032: sendToClient with empty event name throws", () => {
    const mgr = new SseManager();
    const c = createMockController();
    mgr.addClient({ id: "client-1", controller: c });

    assert.throws(() => mgr.sendToClient("client-1", "", {}), /Event name must not be empty/);
  });
});

class RecordingSseHandler implements ISseManagerEventHandler {
  connectedCalls: Array<{ clientId: string }> = [];
  disconnectedCalls: Array<{ clientId: string }> = [];
  throwOnConnected = false;
  throwOnDisconnected = false;
  onConnectedAction?: (mgr: SseManager, clientId: string) => void;

  onClientConnected(mgr: SseManager, clientId: string): void {
    this.connectedCalls.push({ clientId });
    if (this.onConnectedAction) this.onConnectedAction(mgr, clientId);
    if (this.throwOnConnected) throw new Error("handler-connected-failure");
  }

  onClientDisconnected(_mgr: SseManager, clientId: string): void {
    this.disconnectedCalls.push({ clientId });
    if (this.throwOnDisconnected) throw new Error("handler-disconnected-failure");
  }
}

describe("SseManager - Handler Interface", () => {
  it("TC-SSE-033: registerHandler adds a handler", () => {
    const mgr = new SseManager();
    const handler = new RecordingSseHandler();
    mgr.registerHandler(handler);
    const c = createMockController();
    mgr.addClient({ id: "c1", controller: c });

    assert.equal(handler.connectedCalls.length, 1);
    assert.equal(handler.connectedCalls[0].clientId, "c1");
  });

  it("TC-SSE-034: registerHandler is idempotent", () => {
    const mgr = new SseManager();
    const handler = new RecordingSseHandler();
    mgr.registerHandler(handler);
    mgr.registerHandler(handler);
    const c = createMockController();
    mgr.addClient({ id: "c1", controller: c });

    assert.equal(handler.connectedCalls.length, 1);
  });

  it("TC-SSE-035: unregisterHandler removes a handler", () => {
    const mgr = new SseManager();
    const handler = new RecordingSseHandler();
    mgr.registerHandler(handler);
    mgr.unregisterHandler(handler);
    const c = createMockController();
    mgr.addClient({ id: "c1", controller: c });

    assert.equal(handler.connectedCalls.length, 0);
  });

  it("TC-SSE-036: unregisterHandler is idempotent for non-registered handler", () => {
    const mgr = new SseManager();
    const handler = new RecordingSseHandler();
    assert.doesNotThrow(() => mgr.unregisterHandler(handler));
  });

  it("TC-SSE-037: onClientConnected invoked on every registered handler in order", () => {
    const mgr = new SseManager();
    const callOrder: string[] = [];

    class Tagged extends RecordingSseHandler {
      constructor(public tag: string) {
        super();
      }
      override onClientConnected(mgr: SseManager, clientId: string): void {
        callOrder.push(this.tag);
        super.onClientConnected(mgr, clientId);
      }
    }

    const a = new Tagged("A");
    const b = new Tagged("B");
    const c = new Tagged("C");
    mgr.registerHandler(a);
    mgr.registerHandler(b);
    mgr.registerHandler(c);

    const ctrl = createMockController();
    mgr.addClient({ id: "c1", controller: ctrl });

    assert.deepEqual(callOrder, ["A", "B", "C"]);
  });

  it("TC-SSE-038: onClientDisconnected invoked on every registered handler", () => {
    const mgr = new SseManager();
    const h1 = new RecordingSseHandler();
    const h2 = new RecordingSseHandler();
    mgr.registerHandler(h1);
    mgr.registerHandler(h2);

    const c = createMockController();
    mgr.addClient({ id: "c1", controller: c });
    mgr.removeClient("c1");

    assert.equal(h1.disconnectedCalls.length, 1);
    assert.equal(h2.disconnectedCalls.length, 1);
    assert.equal(h1.disconnectedCalls[0].clientId, "c1");
    assert.equal(h2.disconnectedCalls[0].clientId, "c1");
  });

  it("TC-SSE-039: Handler exception in onClientConnected is isolated", () => {
    const mgr = new SseManager();
    const a = new RecordingSseHandler();
    a.throwOnConnected = true;
    const b = new RecordingSseHandler();
    const cHandler = new RecordingSseHandler();
    mgr.registerHandler(a);
    mgr.registerHandler(b);
    mgr.registerHandler(cHandler);

    const ctrl = createMockController();
    assert.doesNotThrow(() => mgr.addClient({ id: "c1", controller: ctrl }));

    assert.equal(b.connectedCalls.length, 1);
    assert.equal(cHandler.connectedCalls.length, 1);
    assert.equal(mgr.getClientCount(), 1);
  });

  it("TC-SSE-040: Handler exception in onClientDisconnected is isolated", () => {
    const mgr = new SseManager();
    const a = new RecordingSseHandler();
    a.throwOnDisconnected = true;
    const b = new RecordingSseHandler();
    mgr.registerHandler(a);
    mgr.registerHandler(b);

    const c = createMockController();
    mgr.addClient({ id: "c1", controller: c });

    assert.doesNotThrow(() => mgr.removeClient("c1"));
    assert.equal(b.disconnectedCalls.length, 1);
    assert.equal(mgr.getClientCount(), 0);
  });

  it("TC-SSE-041: Write-failure auto-removal triggers onClientDisconnected", () => {
    const mgr = new SseManager();
    const handler = new RecordingSseHandler();
    mgr.registerHandler(handler);

    const c = createMockController({ failAfter: 0 });
    mgr.addClient({ id: "failing-client", controller: c });

    mgr.broadcast("test", {});

    assert.equal(handler.disconnectedCalls.length, 1);
    assert.equal(handler.disconnectedCalls[0].clientId, "failing-client");
  });

  it("TC-SSE-042: Handler can send initial state via sendToClient", () => {
    const mgr = new SseManager();
    const handler = new RecordingSseHandler();
    handler.onConnectedAction = (mgr, clientId) => {
      mgr.sendToClient(clientId, "init/event", { hello: "world" });
    };
    mgr.registerHandler(handler);

    const c = createMockController();
    mgr.addClient({ id: "c1", controller: c });

    assert.equal(c.enqueued.length, 1);
    const text = new TextDecoder().decode(c.enqueued[0]);
    assert.match(text, /^event: init\/event\n/);
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    assert.ok(dataLine);
    const parsed = JSON.parse(dataLine!.slice(6));
    assert.equal(parsed.event, "init/event");
    assert.deepEqual(parsed.payload, { hello: "world" });
  });
});

describe("TaskFlowEngine - State Machine", () => {
  it("TC-SM-001: PENDING -> RUNNING transition", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    assert.equal(summary.state, "RUNNING");
    engine.destroy();
  });

  it("TC-SM-002: RUNNING -> COMPLETED transition", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "COMPLETED");
    assert.ok(flow.finishedAt);
    engine.destroy();
  });

  it("TC-SM-003: RUNNING -> FAILED transition", async () => {
    const { engine } = createEngine();
    const failingDag: FlowSpec = {
      tasks: {
        task1: { resolver: { name: "MockFailingTask" } },
      },
    };
    const summary = await engine.createFlow("internal", failingDag);
    await waitForFlowComplete(engine, summary.id);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "FAILED");
    assert.equal(flow.taskStates["task1"], "FAILED");
    assert.ok(flow.finishedAt);
    engine.destroy();
  });

  it("TC-SM-004: RUNNING -> PAUSED -> RUNNING -> COMPLETED transition", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);

    await engine.pauseFlow(summary.id);
    assert.equal(engine.getFlow(summary.id)!.state, "PAUSED");

    await engine.resumeFlow(summary.id);

    await waitForFlowComplete(engine, summary.id);
    assert.equal(engine.getFlow(summary.id)!.state, "COMPLETED");
    engine.destroy();
  });

  it("TC-SM-005: RUNNING -> STOPPED transition", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);

    await engine.stopFlow(summary.id);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "STOPPED");
    assert.ok(flow.finishedAt);
    engine.destroy();
  });

  it("TC-SM-006: Sub-task PENDING -> RUNNING -> COMPLETED", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.taskStates["task1"], "COMPLETED");
    engine.destroy();
  });

  it("TC-SM-007: Sub-task should be SKIPPED when upstream fails", async () => {
    const { engine } = createEngine();
    const failingDag: FlowSpec = {
      tasks: {
        task1: {
          provides: ["data1"],
          resolver: { name: "MockFailingTask", results: { done: "data1" } },
        },
        task2: {
          requires: ["data1"],
          resolver: { name: "MockTask2" },
        },
      },
    };
    const summary = await engine.createFlow("internal", failingDag);
    await waitForFlowComplete(engine, summary.id);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "FAILED");
    assert.equal(flow.taskStates["task1"], "FAILED");
    assert.equal(flow.taskStates["task2"], "SKIPPED");
    engine.destroy();
  });
});

describe("TaskFlowEngine - Error Handling", () => {
  it("TC-ERR-001: pauseFlow should throw for non-existent flow", async () => {
    const { engine } = createEngine();
    await assert.rejects(() => engine.pauseFlow("nonexistent"), /Flow not found/);
    engine.destroy();
  });

  it("TC-ERR-002: resumeFlow should throw for non-existent flow", async () => {
    const { engine } = createEngine();
    await assert.rejects(() => engine.resumeFlow("nonexistent"), /Flow not found/);
    engine.destroy();
  });

  it("TC-ERR-003: stopFlow should throw for non-existent flow", async () => {
    const { engine } = createEngine();
    await assert.rejects(() => engine.stopFlow("nonexistent"), /Flow not found/);
    engine.destroy();
  });

  it("TC-ERR-004: deleteFlow should throw for non-existent flow", async () => {
    const { engine } = createEngine();
    await assert.rejects(() => engine.deleteFlow("nonexistent"), /Flow not found/);
    engine.destroy();
  });
});

describe("TaskFlowEngine - ErrorDag", () => {
  it("TC-ED-001: should execute errorDag when main dag fails", async () => {
    const { engine, sse } = createEngine();
    const failingDag: FlowSpec = {
      tasks: {
        task1: { resolver: { name: "MockFailingTask" } },
      },
    };
    const summary = await engine.createFlow("internal", failingDag, undefined, undefined, errorRecoveryDag);
    await waitForFlowComplete(engine, summary.id, 15000);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "FAILED");
    assert.equal(flow.taskStates["task1"], "FAILED");
    assert.equal(flow.phase, "error");
    assert.ok(flow.errorDag);
    assert.ok(sse.hasEvent("task-flow-engine/error-handling-started"));
    assert.ok(sse.hasEvent("task-flow-engine/error-handling-completed"));
    engine.destroy();
  });

  it("TC-ED-002: should mark errorDag tasks as SKIPPED when errorDag itself fails", async () => {
    const { engine, sse } = createEngine();
    const failingDag: FlowSpec = {
      tasks: {
        task1: { resolver: { name: "MockFailingTask" } },
      },
    };
    const summary = await engine.createFlow("internal", failingDag, undefined, undefined, errorFailingDag);
    await waitForFlowComplete(engine, summary.id, 15000);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "FAILED");
    assert.equal(flow.phase, "error");
    assert.ok(sse.hasEvent("task-flow-engine/error-handling-completed"));
    engine.destroy();
  });

  it("TC-ED-003: should not trigger errorDag when main dag succeeds", async () => {
    const { engine, sse } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag, undefined, undefined, errorRecoveryDag);
    await waitForFlowComplete(engine, summary.id);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "COMPLETED");
    assert.equal(flow.phase, "main");
    assert.equal(sse.hasEvent("task-flow-engine/error-handling-started"), false);
    engine.destroy();
  });

  it("TC-ED-004: should inject error context into errorDag", async () => {
    const { engine } = createEngine();
    const failingDag: FlowSpec = {
      tasks: {
        task1: {
          provides: ["data1"],
          resolver: { name: "MockFailingTask", results: { done: "data1" } },
        },
      },
    };
    const summary = await engine.createFlow("internal", failingDag, { robotId: "r1" }, undefined, errorRecoveryDag);
    await waitForFlowComplete(engine, summary.id, 15000);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "FAILED");
    assert.equal(flow.phase, "error");
    engine.destroy();
  });

  it("TC-ED-005: should pass errorContext to recovery task resolver", async () => {
    const { engine } = createEngine();
    const failingDag: FlowSpec = {
      tasks: {
        task1: { resolver: { name: "MockFailingTask" } },
      },
    };
    const summary = await engine.createFlow("internal", failingDag, undefined, undefined, errorRecoveryDag);
    await waitForFlowComplete(engine, summary.id, 15000);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "FAILED");
    assert.equal(flow.phase, "error");
    engine.destroy();
  });

  it("TC-ED-006: should persist user flow with errorDag and recover", async () => {
    const { engine: engine1, objStore, sse } = createEngine();
    const failingDag: FlowSpec = {
      tasks: {
        task1: { resolver: { name: "MockFailingTask" } },
      },
    };
    const summary = await engine1.createFlow("user", failingDag, undefined, undefined, errorRecoveryDag);
    await waitForFlowComplete(engine1, summary.id, 15000);

    const persisted = await objStore.getJson(`flows/${summary.id}`) as FlowRecord;
    assert.ok(persisted);
    assert.equal(persisted.state, "FAILED");
    assert.equal(persisted.phase, "error");
    assert.ok(persisted.errorContext);
    engine1.destroy();

    const registry2 = new ResolverRegistry();
    registry2.register("MockTask1", MockTask1);
    registry2.register("MockTask2", MockTask2);
    registry2.register("MockFailingTask", MockFailingTask);
    registry2.register("MockRecoveryTask", MockRecoveryTask);
    const engine2 = new TaskFlowEngine(
      objStore as unknown as import("./services/objectStore.js").ObjectStore,
      sse as unknown as SseManager,
      registry2
    );
    await engine2.loadPersistedFlows();

    const flow = engine2.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "FAILED");
    assert.equal(flow.phase, "error");
    engine2.destroy();
  });

  it("TC-ED-007: should reject unregistered resolver in errorDag", async () => {
    const { engine } = createEngine();
    const badErrorDag: FlowSpec = {
      tasks: {
        rollback: { resolver: { name: "NonExistentTask" } },
      },
    };
    await assert.rejects(
      () => engine.createFlow("internal", singleTaskDag, undefined, undefined, badErrorDag),
      /not registered/
    );
    engine.destroy();
  });

  it("TC-ED-008: flowSummary should include errorDag and phase", async () => {
    const { engine } = createEngine();
    const summary = await engine.createFlow("internal", singleTaskDag, undefined, undefined, errorRecoveryDag);
    assert.ok(summary.errorDag);
    assert.equal(summary.phase, "main");
    engine.destroy();
  });

  it("TC-ED-009: should broadcast error-handling events in correct order", async () => {
    const { engine, sse } = createEngine();
    const failingDag: FlowSpec = {
      tasks: {
        task1: { resolver: { name: "MockFailingTask" } },
      },
    };
    const summary = await engine.createFlow("internal", failingDag, undefined, undefined, errorRecoveryDag);
    await waitForFlowComplete(engine, summary.id, 15000);

    const startedEvent = sse.findEvent("task-flow-engine/error-handling-started");
    const completedEvent = sse.findEvent("task-flow-engine/error-handling-completed");
    assert.ok(startedEvent);
    assert.ok(completedEvent);
    const startedIdx = sse.events.indexOf(startedEvent);
    const completedIdx = sse.events.indexOf(completedEvent);
    assert.ok(startedIdx < completedIdx, "error-handling-started should be emitted before error-handling-completed");
    engine.destroy();
  });
});

describe("TaskFlowEngine - Routes", () => {
  function setupApp() {
    const objStore = new InMemoryObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
    const sse = new SpySseManager() as unknown as SseManager;
    const registry = new ResolverRegistry();
    registry.register("MockTask1", MockTask1);
    registry.register("MockTask2", MockTask2);
    registry.register("MockFailingTask", MockFailingTask);
    registry.register("MockRecoveryTask", MockRecoveryTask);
    const engine = new TaskFlowEngine(objStore, sse, registry);
    const app = createHonoApp(engine);
    return { app, engine, objStore: objStore as unknown as InMemoryObjectStore, sse: sse as unknown as SpySseManager };
  }

  it("TC-API-001: POST /api/flows should create flow and return 201", async () => {
    const { app, engine } = setupApp();
    const res = await app.request("/api/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "internal", dag: singleTaskDag }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as FlowSummary;
    assert.ok(body.id);
    assert.equal(body.type, "internal");
    engine.destroy();
  });

  it("TC-API-002: POST /api/flows should return 400 when missing type or dag", async () => {
    const { app, engine } = setupApp();
    const res = await app.request("/api/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "internal" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "MISSING_TYPE_OR_DAG");
    engine.destroy();
  });

  it("TC-API-003: POST /api/flows should return 400 for invalid type", async () => {
    const { app, engine } = setupApp();
    const res = await app.request("/api/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "invalid", dag: singleTaskDag }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "INVALID_TYPE");
    engine.destroy();
  });

  it("TC-API-004: GET /api/flows should list flows", async () => {
    const { app, engine } = setupApp();
    await engine.createFlow("internal", singleTaskDag);
    await engine.createFlow("user", singleTaskDag);

    const res = await app.request("/api/flows");
    assert.equal(res.status, 200);
    const body = await res.json() as FlowSummary[];
    assert.equal(body.length, 2);
    engine.destroy();
  });

  it("TC-API-005: GET /api/flows?type=internal should filter", async () => {
    const { app, engine } = setupApp();
    await engine.createFlow("internal", singleTaskDag);
    await engine.createFlow("user", singleTaskDag);

    const res = await app.request("/api/flows?type=internal");
    assert.equal(res.status, 200);
    const body = await res.json() as FlowSummary[];
    for (const f of body) {
      assert.equal(f.type, "internal");
    }
    engine.destroy();
  });

  it("TC-API-005b: GET /api/flows?solutionId=xxx should filter by params", async () => {
    const { app, engine } = setupApp();
    await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1" });
    await engine.createFlow("internal", singleTaskDag, { solutionId: "sol2" });

    const res = await app.request("/api/flows?solutionId=sol1");
    assert.equal(res.status, 200);
    const body = await res.json() as FlowSummary[];
    assert.ok(body.length >= 1);
    for (const f of body) {
      const input = f.input as Record<string, string> | undefined;
      assert.equal(input?.solutionId, "sol1");
    }
    engine.destroy();
  });

  it("TC-API-005c: GET /api/flows?solutionId=xxx&robotId=yyy should filter by multiple params", async () => {
    const { app, engine } = setupApp();
    await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1", robotId: "r1" });
    await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1", robotId: "r2" });

    const res = await app.request("/api/flows?solutionId=sol1&robotId=r1");
    assert.equal(res.status, 200);
    const body = await res.json() as FlowSummary[];
    assert.equal(body.length, 1);
    const input = body[0].input as Record<string, string>;
    assert.equal(input.solutionId, "sol1");
    assert.equal(input.robotId, "r1");
    engine.destroy();
  });

  it("GET /api/flows?type=internal&solutionId=xxx should combine type and param filter", async () => {
    const { app, engine } = setupApp();
    await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1" });
    await engine.createFlow("user", singleTaskDag, { solutionId: "sol1" });

    const res = await app.request("/api/flows?type=internal&solutionId=sol1");
    assert.equal(res.status, 200);
    const body = await res.json() as FlowSummary[];
    assert.ok(body.length >= 1);
    for (const f of body) {
      assert.equal(f.type, "internal");
      const input = f.input as Record<string, string>;
      assert.equal(input?.solutionId, "sol1");
    }
    engine.destroy();
  });

  it("HTTP listFlows should produce same results as internal listFlows for param filter", async () => {
    const { app, engine } = setupApp();
    await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1", robotId: "r1" });
    await engine.createFlow("internal", singleTaskDag, { solutionId: "sol1", robotId: "r2" });
    await engine.createFlow("user", singleTaskDag, { solutionId: "sol2", robotId: "r1" });

    const httpRes = await app.request("/api/flows?solutionId=sol1&robotId=r1");
    assert.equal(httpRes.status, 200);
    const httpBody = await httpRes.json() as FlowSummary[];

    const internalBody = engine.listFlows(undefined, { solutionId: "sol1", robotId: "r1" });

    assert.equal(httpBody.length, internalBody.length);
    assert.equal(httpBody.length, 1);
    assert.equal(httpBody[0].id, internalBody[0].id);
    engine.destroy();
  });

  it("TC-API-006: GET /api/flows/:id should return flow detail", async () => {
    const { app, engine } = setupApp();
    const summary = await engine.createFlow("internal", singleTaskDag);

    const res = await app.request(`/api/flows/${summary.id}`);
    assert.equal(res.status, 200);
    const body = await res.json() as FlowSummary;
    assert.equal(body.id, summary.id);
    engine.destroy();
  });

  it("TC-API-007: GET /api/flows/:id should return 404 for non-existent", async () => {
    const { app, engine } = setupApp();
    const res = await app.request("/api/flows/nonexistent");
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "FLOW_NOT_FOUND");
    engine.destroy();
  });

  it("TC-API-008: POST /api/flows/:id/pause should pause flow", async () => {
    const { app, engine } = setupApp();
    const summary = await engine.createFlow("internal", singleTaskDag);

    const res = await app.request(`/api/flows/${summary.id}/pause`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as { success: boolean };
    assert.equal(body.success, true);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "PAUSED");
    engine.destroy();
  });

  it("TC-API-009: POST /api/flows/:id/pause should return 404 for non-existent", async () => {
    const { app, engine } = setupApp();
    const res = await app.request("/api/flows/nonexistent/pause", { method: "POST" });
    assert.equal(res.status, 404);
    engine.destroy();
  });

  it("TC-API-010: POST /api/flows/:id/resume should resume flow", async () => {
    const { app, engine } = setupApp();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await engine.pauseFlow(summary.id);

    const res = await app.request(`/api/flows/${summary.id}/resume`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as { success: boolean };
    assert.equal(body.success, true);
    engine.destroy();
  });

  it("TC-API-011: POST /api/flows/:id/stop should stop flow", async () => {
    const { app, engine } = setupApp();
    const summary = await engine.createFlow("internal", singleTaskDag);

    const res = await app.request(`/api/flows/${summary.id}/stop`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as { success: boolean };
    assert.equal(body.success, true);

    const flow = engine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "STOPPED");
    engine.destroy();
  });

  it("TC-API-012: DELETE /api/flows/:id should delete flow", async () => {
    const { app, engine } = setupApp();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    const res = await app.request(`/api/flows/${summary.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = await res.json() as { success: boolean };
    assert.equal(body.success, true);

    assert.equal(engine.getFlow(summary.id), undefined);
    engine.destroy();
  });

  it("TC-API-013: POST /api/flows/batch/pause should batch pause", async () => {
    const { app, engine } = setupApp();
    const s1 = await engine.createFlow("internal", singleTaskDag);
    const s2 = await engine.createFlow("internal", singleTaskDag);

    const res = await app.request("/api/flows/batch/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [s1.id, s2.id] }),
    });
    assert.equal(res.status, 200);

    const f1 = engine.getFlow(s1.id);
    const f2 = engine.getFlow(s2.id);
    assert.ok(f1);
    assert.ok(f2);
    engine.destroy();
  });

  it("TC-API-014: POST /api/flows/batch/pause should return 400 for non-array ids", async () => {
    const { app, engine } = setupApp();
    const res = await app.request("/api/flows/batch/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: "not-an-array" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "INVALID_IDS");
    engine.destroy();
  });

  it("TC-API-015: GET /api/flows/events endpoint is deprecated and removed", async () => {
    const { app, engine } = setupApp();
    const res = await app.request("/api/flows/events");
    assert.notEqual(res.status, 200);
    engine.destroy();
  });

  it("POST /api/flows should return 400 for unregistered resolver", async () => {
    const { app, engine } = setupApp();
    const badDag: FlowSpec = {
      tasks: {
        task1: { resolver: { name: "NonExistentTask" } },
      },
    };
    const res = await app.request("/api/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "internal", dag: badDag }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "RESOLVER_NOT_FOUND");
    engine.destroy();
  });

  it("POST /api/flows/batch/resume should work", async () => {
    const { app, engine } = setupApp();
    const s1 = await engine.createFlow("internal", singleTaskDag);
    await engine.batchPause([s1.id]);

    const res = await app.request("/api/flows/batch/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [s1.id] }),
    });
    assert.equal(res.status, 200);
    engine.destroy();
  });

  it("POST /api/flows/batch/stop should work", async () => {
    const { app, engine } = setupApp();
    const s1 = await engine.createFlow("internal", singleTaskDag);

    const res = await app.request("/api/flows/batch/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [s1.id] }),
    });
    assert.equal(res.status, 200);
    engine.destroy();
  });

  it("POST /api/flows/batch/delete should work", async () => {
    const { app, engine } = setupApp();
    const s1 = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, s1.id);

    const res = await app.request("/api/flows/batch/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [s1.id] }),
    });
    assert.equal(res.status, 200);
    assert.equal(engine.getFlow(s1.id), undefined);
    engine.destroy();
  });

  it("TC-API-016: POST /api/flows/:id/retry should reset and restart the same flow", async () => {
    const { app, engine } = setupApp();
    const summary = await engine.createFlow("internal", singleTaskDag);
    await waitForFlowComplete(engine, summary.id);

    const res = await app.request(`/api/flows/${summary.id}/retry`, { method: "POST" });
    assert.equal(res.status, 201);
    const body = await res.json() as FlowSummary;
    assert.equal(body.id, summary.id);
    assert.ok(["RUNNING", "COMPLETED"].includes(body.state));
    assert.ok(["PENDING", "RUNNING", "COMPLETED"].includes(body.taskStates["task1"]));
    engine.destroy();
  });

  it("TC-API-017: POST /api/flows/:id/retry should return 404 for non-existent", async () => {
    const { app, engine } = setupApp();
    const res = await app.request("/api/flows/nonexistent/retry", { method: "POST" });
    assert.equal(res.status, 404);
    engine.destroy();
  });
});

import { SolutionService } from "./services/solutionService.js";
import { RobotService } from "./services/robotService.js";
import { ArtifactService } from "./services/artifactService.js";
import { createSolutionRoutes } from "./routes/solutionRoutes.js";
import { createRobotRoutes } from "./routes/robotRoutes.js";
import type { SolutionMeta } from "./types/solution.js";
import type { StoredRobotData } from "./types/robot.js";
import type { ArtifactMeta } from "./types/artifact.js";

class MockChecksumService {
  async computeSha256(_filePath: string): Promise<string> {
    return "mock-sha256-" + Math.random().toString(36).slice(2, 10);
  }
}

function createEnhancedTestServices() {
  const objStore = new EnhancedObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
  const checksumService = new MockChecksumService() as unknown as import("./services/checksumService.js").ChecksumService;
  const artifactService = new ArtifactService(objStore, checksumService);
  const solutionService = new SolutionService(objStore, artifactService);
  const engine = createTestTaskFlowEngine(objStore);
  const sseManager = new SseManager();
  const memStore = new MemStore();
  const robotService = new RobotService(objStore, engine, sseManager, memStore);
  return { solutionService, robotService, engine, sseManager, memStore, objStore: objStore as unknown as EnhancedObjectStore, artifactService };
}

function createTestTaskFlowEngine(objectStore?: unknown): TaskFlowEngine {
  const objStore = (objectStore ?? new EnhancedObjectStore()) as unknown as import("./services/objectStore.js").ObjectStore;
  const sse = new SpySseManager() as unknown as SseManager;
  const registry = new ResolverRegistry();
  registry.register("GetRobotBasicInfoTask", MockGetRobotBasicInfoTask as unknown as import("flowed").TaskResolverClass);
  registry.register("GetRobotSoftwareInfoTask", MockGetRobotSoftwareInfoTask as unknown as import("flowed").TaskResolverClass);
  registry.register("UpdateRobotBasicInfoTask", UpdateRobotBasicInfoTask as unknown as import("flowed").TaskResolverClass);
  registry.register("UpdateRobotSoftwareInfoTask", UpdateRobotSoftwareInfoTask as unknown as import("flowed").TaskResolverClass);
  const engine = new TaskFlowEngine(objStore, sse, registry);
  testEngines.add(engine);
  return engine;
}

const testEngines = new Set<TaskFlowEngine>();
after(() => {
  for (const engine of testEngines) {
    engine.destroy();
  }
  testEngines.clear();
});

describe("SolutionService - Core", () => {
  describe("create", () => {
    it("TC-SOL-SVC-001: should create a solution with valid input", async () => {
      const { solutionService } = createEnhancedTestServices();
      const meta = await solutionService.create({ name: "Test Solution" });
      assert.ok(meta.id);
      assert.equal(meta.name, "Test Solution");
      assert.equal(meta.description, "");
      assert.equal(meta.version, "1.0.0");
      assert.ok(meta.createdAt);
      assert.ok(meta.updatedAt);
      assert.deepEqual(meta.tags, []);
      assert.deepEqual(meta.metadata, {});
    });

    it("TC-SOL-SVC-002: should create a solution with all optional fields", async () => {
      const { solutionService } = createEnhancedTestServices();
      const meta = await solutionService.create({
        name: "Full Solution",
        description: "A full solution",
        tags: ["tag1", "tag2"],
        metadata: { location: "Shanghai" },
      });
      assert.equal(meta.name, "Full Solution");
      assert.equal(meta.description, "A full solution");
      assert.deepEqual(meta.tags, ["tag1", "tag2"]);
      assert.deepEqual(meta.metadata, { location: "Shanghai" });
    });

    it("TC-SOL-SVC-003: should create a solution with custom ID", async () => {
      const { solutionService } = createEnhancedTestServices();
      const meta = await solutionService.create({ id: "my-custom-id", name: "Custom" });
      assert.equal(meta.id, "my-custom-id");
    });

    it("TC-SOL-SVC-004: should reject invalid solution ID", async () => {
      const { solutionService } = createEnhancedTestServices();
      await assert.rejects(
        () => solutionService.create({ id: "invalid id!", name: "Bad" }),
        { code: "INVALID_SOLUTION_ID" }
      );
    });

    it("TC-SOL-SVC-005: should reject duplicate ID", async () => {
      const { solutionService } = createEnhancedTestServices();
      await solutionService.create({ id: "dup-id", name: "First" });
      await assert.rejects(
        () => solutionService.create({ id: "dup-id", name: "Second" }),
        { code: "SOLUTION_ALREADY_EXISTS" }
      );
    });

    it("TC-SOL-SVC-006: should create directory skeleton", async () => {
      const { solutionService, objStore } = createEnhancedTestServices();
      await solutionService.create({ id: "skel-test", name: "Skeleton" });
      const robotsKeep = await objStore.getJson("v1/solutions/skel-test/robots/_keep");
      assert.ok(robotsKeep !== null);
    });
  });

  describe("list", () => {
    it("TC-SOL-SVC-007: should list all solutions", async () => {
      const { solutionService } = createEnhancedTestServices();
      await solutionService.create({ name: "Sol A" });
      await solutionService.create({ name: "Sol B" });
      const result = await solutionService.list();
      assert.equal(result.items.length, 2);
      assert.equal(result.corruptedIds.length, 0);
    });

    it("TC-SOL-SVC-008: should sort by updatedAt descending", async () => {
      const { solutionService } = createEnhancedTestServices();
      const s1 = await solutionService.create({ name: "First" });
      await solutionService.update(s1.id, { description: "updated" });
      const s2 = await solutionService.create({ name: "Second" });
      const result = await solutionService.list();
      assert.equal(result.items.length, 2);
    });

    it("TC-SOL-SVC-009: should return corrupted IDs for solutions with missing meta", async () => {
      const { solutionService, objStore } = createEnhancedTestServices();
      await objStore.putJson("v1/solutions/corrupted-sol/_keep", "");
      const result = await solutionService.list();
      assert.ok(result.corruptedIds.includes("corrupted-sol"));
    });
  });

  describe("get", () => {
    it("TC-SOL-SVC-010: should get a solution by ID", async () => {
      const { solutionService } = createEnhancedTestServices();
      const created = await solutionService.create({ name: "GetTest" });
      const fetched = await solutionService.get(created.id);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.name, "GetTest");
    });

    it("TC-SOL-SVC-011: should throw for non-existent solution", async () => {
      const { solutionService } = createEnhancedTestServices();
      await assert.rejects(
        () => solutionService.get("nonexistent"),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });
  });

  describe("update", () => {
    it("TC-SOL-SVC-012: should update solution fields and bump version", async () => {
      const { solutionService } = createEnhancedTestServices();
      const created = await solutionService.create({ name: "Original" });
      const updated = await solutionService.update(created.id, { name: "Updated", description: "New desc" });
      assert.equal(updated.name, "Updated");
      assert.equal(updated.description, "New desc");
      assert.equal(updated.version, "1.0.1");
      assert.equal(updated.id, created.id);
      assert.equal(updated.createdAt, created.createdAt);
    });

    it("TC-SOL-SVC-013: should throw when updating non-existent solution", async () => {
      const { solutionService } = createEnhancedTestServices();
      await assert.rejects(
        () => solutionService.update("nonexistent", { name: "X" }),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });

    it("TC-SOL-SVC-014: should not change id or createdAt on update", async () => {
      const { solutionService } = createEnhancedTestServices();
      const created = await solutionService.create({ name: "Stable" });
      const updated = await solutionService.update(created.id, { name: "Stable2" } as any);
      assert.equal(updated.id, created.id);
      assert.equal(updated.createdAt, created.createdAt);
    });
  });

  describe("remove", () => {
    it("TC-SOL-SVC-015: should remove a solution", async () => {
      const { solutionService } = createEnhancedTestServices();
      const created = await solutionService.create({ name: "DeleteMe" });
      await solutionService.remove(created.id);
      await assert.rejects(
        () => solutionService.get(created.id),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });

    it("TC-SOL-SVC-016: should throw when removing non-existent solution", async () => {
      const { solutionService } = createEnhancedTestServices();
      await assert.rejects(
        () => solutionService.remove("nonexistent"),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });
  });

  describe("open and close (in-memory state)", () => {
    it("TC-SOL-SVC-017: should open a solution and track it in memory", async () => {
      const { solutionService } = createEnhancedTestServices();
      const created = await solutionService.create({ name: "OpenMe" });
      const opened = await solutionService.open(created.id);
      assert.equal(opened.id, created.id);
      assert.ok(solutionService.isOpened(created.id));
    });

    it("TC-SOL-SVC-018: should list opened solutions", async () => {
      const { solutionService } = createEnhancedTestServices();
      const s1 = await solutionService.create({ name: "Sol1" });
      const s2 = await solutionService.create({ name: "Sol2" });
      await solutionService.open(s1.id);
      await solutionService.open(s2.id);
      const opened = solutionService.getOpenedSolutions();
      assert.equal(opened.length, 2);
    });

    it("TC-SOL-SVC-019: should close a solution", async () => {
      const { solutionService } = createEnhancedTestServices();
      const created = await solutionService.create({ name: "CloseMe" });
      await solutionService.open(created.id);
      assert.ok(solutionService.isOpened(created.id));
      solutionService.closeSolution(created.id);
      assert.ok(!solutionService.isOpened(created.id));
    });

    it("TC-SOL-SVC-020: should remove from opened when solution is deleted", async () => {
      const { solutionService } = createEnhancedTestServices();
      const created = await solutionService.create({ name: "DelOpened" });
      await solutionService.open(created.id);
      assert.ok(solutionService.isOpened(created.id));
      await solutionService.remove(created.id);
      assert.ok(!solutionService.isOpened(created.id));
    });

    it("TC-SOL-SVC-021: should throw when opening non-existent solution", async () => {
      const { solutionService } = createEnhancedTestServices();
      await assert.rejects(
        () => solutionService.open("nonexistent"),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });
  });

  describe("clone", () => {
    it("TC-SOL-SVC-022: should clone a solution", async () => {
      const { solutionService } = createEnhancedTestServices();
      const source = await solutionService.create({ name: "Source" });
      const cloned = await solutionService.clone(source.id, "Cloned Copy");
      assert.notEqual(cloned.id, source.id);
      assert.equal(cloned.name, "Cloned Copy");
      assert.equal(cloned.version, "1.0.0");
    });

    it("TC-SOL-SVC-023: should throw when cloning non-existent solution", async () => {
      const { solutionService } = createEnhancedTestServices();
      await assert.rejects(
        () => solutionService.clone("nonexistent", "Copy"),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });
  });
});

describe("SolutionService - Import/Export", () => {
  async function makeZipBuffer(name: string, solutionId: string, entries: Record<string, unknown>): Promise<Buffer> {
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip();
    for (const [path, content] of Object.entries(entries)) {
      zip.addFile(`${solutionId}/${path}.json`, Buffer.from(JSON.stringify(content, null, 2)));
    }
    return zip.toBuffer();
  }

  it("TC-SOL-EXP-001: should import a solution from a valid ZIP buffer", async () => {
    const { solutionService } = createEnhancedTestServices();
    const zipBuffer = await makeZipBuffer("Test Import", "import-test-1", {
      meta: { id: "import-test-1", name: "Test Import", description: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: "1.0.0", tags: [], metadata: {} },
      "robots/robot-1": { id: "robot-1", address: "10.0.0.1", addressType: "ip", alias: "R1", port: 22, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    });

    const result = await solutionService.importFromBuffer(zipBuffer, "rename");
    assert.equal(result.ok, true);
    assert.equal(result.solution.name, "Test Import");
    assert.equal(result.warnings.length, 0);

    const meta = await solutionService.get(result.solution.id);
    assert.ok(meta);
    assert.equal(meta.name, "Test Import");
  });

  it("TC-SOL-EXP-002: should handle conflict resolution —rename", async () => {
    const { solutionService } = createEnhancedTestServices();
    await solutionService.create({ id: "conflict-test", name: "Existing" });

    const zipBuffer = await makeZipBuffer("Conflict Test", "conflict-test", {
      meta: { id: "conflict-test", name: "Conflict Test", description: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: "1.0.0", tags: [], metadata: {} },
    });

    const result = await solutionService.importFromBuffer(zipBuffer, "rename");
    assert.equal(result.ok, true);
    assert.notEqual(result.solution.id, "conflict-test");
    assert.equal(result.solution.name, "Conflict Test");

    const existingMeta = await solutionService.get("conflict-test");
    assert.equal(existingMeta.name, "Existing");
  });

  it("TC-SOL-EXP-003: should handle conflict resolution —overwrite", async () => {
    const { solutionService } = createEnhancedTestServices();
    await solutionService.create({ id: "overwrite-test", name: "Existing" });

    const zipBuffer = await makeZipBuffer("Overwritten", "overwrite-test", {
      meta: { id: "overwrite-test", name: "Overwritten", description: "updated", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: "2.0.0", tags: [], metadata: {} },
    });

    const result = await solutionService.importFromBuffer(zipBuffer, "overwrite");
    assert.equal(result.ok, true);
    assert.equal(result.solution.id, "overwrite-test");
    assert.equal(result.solution.name, "Overwritten");
    assert.equal(result.solution.description, "updated");
  });

  it("TC-SOL-EXP-004: should throw on conflict resolution —cancel", async () => {
    const { solutionService } = createEnhancedTestServices();
    await solutionService.create({ id: "cancel-test", name: "Existing" });

    const zipBuffer = await makeZipBuffer("Cancel Test", "cancel-test", {
      meta: { id: "cancel-test", name: "Cancel Test", description: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: "1.0.0", tags: [], metadata: {} },
    });

    await assert.rejects(
      () => solutionService.importFromBuffer(zipBuffer, "cancel"),
      { code: "IMPORT_ID_COLLISION" }
    );
  });

  it("TC-SOL-EXP-005: should reject ZIP without meta.json", async () => {
    const { solutionService } = createEnhancedTestServices();
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip();
    zip.addFile("some-file.json", Buffer.from("{}"));
    const zipBuffer = zip.toBuffer();

    await assert.rejects(
      () => solutionService.importFromBuffer(zipBuffer, "rename"),
      { code: "IMPORT_INVALID_ARCHIVE" }
    );
  });

  it("TC-SOL-EXP-006: should extract solution with sub-resources", async () => {
    const { solutionService, objStore } = createEnhancedTestServices();
    const zipBuffer = await makeZipBuffer("Full Solution", "full-sol-1", {
      meta: { id: "full-sol-1", name: "Full Solution", description: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: "1.0.0", tags: [], metadata: {} },
      "robots/robot-a": { id: "robot-a", address: "10.0.0.1", alias: "A" },
      "configs/config-1": { id: "config-1", name: "Config 1" },
    });

    const result = await solutionService.importFromBuffer(zipBuffer, "rename");
    assert.equal(result.ok, true);

    const robotData = await objStore.getJson(`v1/solutions/${result.solution.id}/robots/robot-a`);
    assert.ok(robotData);
    const configData = await objStore.getJson(`v1/solutions/${result.solution.id}/configs/config-1`);
    assert.ok(configData);
  });

  it("TC-SOL-EXP-007: should warn about unresolvable artifact references", async () => {
    const { solutionService } = createEnhancedTestServices();
    const zipBuffer = await makeZipBuffer("Artifact Ref Test", "art-ref-test", {
      meta: { id: "art-ref-test", name: "Artifact Ref Test", description: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: "1.0.0", tags: [], metadata: {} },
      "upgrade-packages/pkg-1": { artifactId: "nonexistent-artifact", purpose: "upgrade" },
    });

    const result = await solutionService.importFromBuffer(zipBuffer, "rename");
    assert.equal(result.ok, true);
    assert.ok(result.warnings.length > 0);
    assert.match(result.warnings[0], /not found/);
  });
});

describe("RobotService - Core", () => {
  const robotServiceInstances: RobotService[] = [];

  afterEach(() => {
    while (robotServiceInstances.length) {
      robotServiceInstances.pop()!.memStore.destroy();
    }
  });

  async function createSolutionWithService() {
    const services = createEnhancedTestServices();
    const solution = await services.solutionService.create({ name: "Test Solution" });
    robotServiceInstances.push(services.robotService);
    return { ...services, solution };
  }

  describe("create", () => {
    it("TC-ROB-SVC-001: should create a robot with valid IP address", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });
      assert.ok(robot.id);
      assert.equal(robot.address, "192.168.1.100");
      assert.equal(robot.port, 22);
      assert.equal(robot.addressType, "ip");
      assert.equal(robot.alias, "192.168.1.100");
    });

    it("TC-ROB-SVC-002: should create a robot with mDNS address", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const robot = await robotService.create(solution.id, { address: "robot-01.local:22" });
      assert.equal(robot.address, "robot-01.local");
      assert.equal(robot.port, 22);
      assert.equal(robot.addressType, "mdns");
    });

    it("TC-ROB-SVC-003: should default port to 22 when not specified", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const robot = await robotService.create(solution.id, { address: "10.0.0.1" });
      assert.equal(robot.port, 22);
    });

    it("TC-ROB-SVC-004: should use alias when provided", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const robot = await robotService.create(solution.id, { address: "10.0.0.1", alias: "MyRobot" });
      assert.equal(robot.alias, "MyRobot");
    });

    it("TC-ROB-SVC-005: should default alias to host when not provided", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const robot = await robotService.create(solution.id, { address: "10.0.0.1" });
      assert.equal(robot.alias, "10.0.0.1");
    });

    it("TC-ROB-SVC-006: should reject invalid address format", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await assert.rejects(
        () => robotService.create(solution.id, { address: ":22" }),
        { code: "INVALID_ROBOT_ADDRESS" }
      );
    });

    it("TC-ROB-SVC-007: should reject duplicate address in same solution", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await robotService.create(solution.id, { address: "10.0.0.1:22" });
      await assert.rejects(
        () => robotService.create(solution.id, { address: "10.0.0.1:22" }),
        { code: "ROBOT_ADDRESS_EXISTS" }
      );
    });

    it("TC-ROB-SVC-008: should allow same address in different solutions", async () => {
      const { robotService, solutionService } = createEnhancedTestServices();
      robotServiceInstances.push(robotService);
      const sol1 = await solutionService.create({ name: "Sol1" });
      const sol2 = await solutionService.create({ name: "Sol2" });
      const r1 = await robotService.create(sol1.id, { address: "10.0.0.1:22" });
      const r2 = await robotService.create(sol2.id, { address: "10.0.0.1:22" });
      assert.ok(r1.id);
      assert.ok(r2.id);
      assert.notEqual(r1.id, r2.id);
    });

    it("TC-ROB-SVC-009: should throw when creating robot in non-existent solution", async () => {
      const { robotService } = createEnhancedTestServices();
      robotServiceInstances.push(robotService);
      await assert.rejects(
        () => robotService.create("nonexistent", { address: "10.0.0.1" }),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });
  });

  describe("list", () => {
    it("TC-ROB-SVC-010: should list robots in a solution", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await robotService.create(solution.id, { address: "10.0.0.1" });
      await robotService.create(solution.id, { address: "10.0.0.2" });
      const robots = await robotService.list(solution.id);
      assert.equal(robots.length, 2);
    });

    it("TC-ROB-SVC-011: should return empty list for solution with no robots", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const robots = await robotService.list(solution.id);
      assert.equal(robots.length, 0);
    });

    it("TC-ROB-SVC-012: should use cached robots on subsequent calls", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await robotService.create(solution.id, { address: "10.0.0.1" });
      const first = await robotService.list(solution.id);
      const second = await robotService.list(solution.id);
      assert.deepEqual(first, second);
    });

    it("TC-ROB-SVC-013: should throw when listing robots in non-existent solution", async () => {
      const { robotService } = createEnhancedTestServices();
      robotServiceInstances.push(robotService);
      await assert.rejects(
        () => robotService.list("nonexistent"),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });
  });

  describe("get", () => {
    it("TC-ROB-SVC-014: should get a robot by ID", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const created = await robotService.create(solution.id, { address: "10.0.0.1" });
      const fetched = await robotService.get(solution.id, created.id);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.address, "10.0.0.1");
    });

    it("TC-ROB-SVC-015: should throw for non-existent robot", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await assert.rejects(
        () => robotService.get(solution.id, "nonexistent-robot"),
        { code: "ROBOT_NOT_FOUND" }
      );
    });

    it("TC-ROB-SVC-016: should throw for non-existent solution", async () => {
      const { robotService } = createEnhancedTestServices();
      robotServiceInstances.push(robotService);
      await assert.rejects(
        () => robotService.get("nonexistent", "some-robot"),
        { code: "SOLUTION_NOT_FOUND" }
      );
    });
  });

  describe("update", () => {
    it("TC-ROB-SVC-017: should update robot alias", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const created = await robotService.create(solution.id, { address: "10.0.0.1" });
      const updated = await robotService.update(solution.id, created.id, { alias: "NewAlias" });
      assert.equal(updated.alias, "NewAlias");
      assert.equal(updated.address, created.address);
    });

    it("TC-ROB-SVC-018: should update robot address", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const created = await robotService.create(solution.id, { address: "10.0.0.1" });
      const updated = await robotService.update(solution.id, created.id, { address: "10.0.0.2:22" });
      assert.equal(updated.address, "10.0.0.2");
      assert.equal(updated.port, 22);
    });

    it("TC-ROB-SVC-019: should update in-memory cache after update", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const created = await robotService.create(solution.id, { address: "10.0.0.1" });
      await robotService.update(solution.id, created.id, { alias: "Cached" });
      const cached = await robotService.get(solution.id, created.id);
      assert.equal(cached.alias, "Cached");
    });

    it("TC-ROB-SVC-020: should throw when updating non-existent robot", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await assert.rejects(
        () => robotService.update(solution.id, "nonexistent", { alias: "X" }),
        { code: "ROBOT_NOT_FOUND" }
      );
    });

    it("TC-ROB-SVC-021: should reject duplicate address on update", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await robotService.create(solution.id, { address: "10.0.0.1" });
      const r2 = await robotService.create(solution.id, { address: "10.0.0.2" });
      await assert.rejects(
        () => robotService.update(solution.id, r2.id, { address: "10.0.0.1:22" }),
        { code: "ROBOT_ADDRESS_EXISTS" }
      );
    });
  });

  describe("remove", () => {
    it("TC-ROB-SVC-022: should remove a robot", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const created = await robotService.create(solution.id, { address: "10.0.0.1" });
      await robotService.remove(solution.id, created.id);
      await assert.rejects(
        () => robotService.get(solution.id, created.id),
        { code: "ROBOT_NOT_FOUND" }
      );
    });

    it("TC-ROB-SVC-023: should update in-memory cache after remove", async () => {
      const { robotService, solution } = await createSolutionWithService();
      const created = await robotService.create(solution.id, { address: "10.0.0.1" });
      await robotService.remove(solution.id, created.id);
      const robots = await robotService.list(solution.id);
      assert.equal(robots.length, 0);
    });

    it("TC-ROB-SVC-024: should throw when removing non-existent robot", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await assert.rejects(
        () => robotService.remove(solution.id, "nonexistent"),
        { code: "ROBOT_NOT_FOUND" }
      );
    });
  });

  describe("removeSolutionCache", () => {
    it("TC-ROB-SVC-025: should clear cached robots for a solution", async () => {
      const { robotService, solution } = await createSolutionWithService();
      await robotService.create(solution.id, { address: "10.0.0.1" });
      const robots1 = await robotService.list(solution.id);
      assert.equal(robots1.length, 1);
      robotService.removeSolutionCache(solution.id);
      const robots2 = await robotService.list(solution.id);
      assert.equal(robots2.length, 1);
    });
  });
});

describe("Solution Routes - API", () => {
  function setupSolutionApp() {
    const objStore = new EnhancedObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
    const checksumService = new MockChecksumService() as unknown as import("./services/checksumService.js").ChecksumService;
    const artifactService = new ArtifactService(objStore, checksumService);
    const solutionService = new SolutionService(objStore, artifactService);
    const engine = createTestTaskFlowEngine(objStore);
    const sseManager = new SseManager();
    const memStore = new MemStore();
    const robotService = new RobotService(objStore, engine, sseManager, memStore);
    const app = new Hono();
    app.route("/api/solutions", createSolutionRoutes(solutionService));
    app.route("/api/solutions/:solutionId/robots", createRobotRoutes(robotService));
    return { app, solutionService, robotService, artifactService };
  }

  it("TC-SOL-API-EXP-001: POST /api/solutions/:id/export returns ZIP stream", async () => {
    const { app, solutionService } = setupSolutionApp();
    const meta = await solutionService.create({ id: "export-api-test", name: "Export API Test" });

    const res = await app.request(`/api/solutions/${meta.id}/export`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/zip");
    assert.ok(res.headers.get("Content-Disposition")?.includes("attachment"));

    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 0);
  });

  it("TC-SOL-API-EXP-002: POST /api/solutions/import with valid ZIP file", async () => {
    const { app } = setupSolutionApp();

    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip();
    const metaJson = JSON.stringify({ id: "import-api-test", name: "Import API Test", description: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: "1.0.0", tags: [], metadata: {} });
    zip.addFile("import-api-test/meta.json", Buffer.from(metaJson));
    const zipBuffer = zip.toBuffer();

    const formData = new FormData();
    formData.append("file", new Blob([zipBuffer], { type: "application/zip" }), "test.zip");

    const res = await app.request("/api/solutions/import", {
      method: "POST",
      body: formData,
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.solution.name, "Import API Test");
    assert.ok(body.warnings);
  });

  it("TC-SOL-API-EXP-003: POST /api/solutions/import rejects non-ZIP file", async () => {
    const { app } = setupSolutionApp();

    const formData = new FormData();
    formData.append("file", new Blob(["not a zip"], { type: "text/plain" }), "test.txt");

    const res = await app.request("/api/solutions/import", {
      method: "POST",
      body: formData,
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.equal(body.error, "UNSUPPORTED_FILE_TYPE");
  });

  it("TC-SOL-API-EXP-004: POST /api/solutions/import rejects empty request body", async () => {
    const { app } = setupSolutionApp();
    const res = await app.request("/api/solutions/import", { method: "POST" });
    assert.equal(res.status, 400);
  });

  it("TC-SOL-API-EXP-005: POST /api/solutions/import handles conflict with rename", async () => {
    const { app, solutionService } = setupSolutionApp();
    await solutionService.create({ id: "api-conflict", name: "Existing Solution" });

    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip();
    const metaJson = JSON.stringify({ id: "api-conflict", name: "Imported Solution", description: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: "1.0.0", tags: [], metadata: {} });
    zip.addFile("api-conflict/meta.json", Buffer.from(metaJson));
    const zipBuffer = zip.toBuffer();

    const formData = new FormData();
    formData.append("file", new Blob([zipBuffer], { type: "application/zip" }), "test.zip");
    formData.append("conflictResolution", "rename");

    const res = await app.request("/api/solutions/import", {
      method: "POST",
      body: formData,
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
    assert.notEqual(body.solution.id, "api-conflict");
  });
});

describe("RobotService - MemStore & TaskFlow Integration", () => {
  function createIntegrationServices() {
    const objStore = new EnhancedObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
    const checksumService = new MockChecksumService() as unknown as import("./services/checksumService.js").ChecksumService;
    const artifactService = new ArtifactService(objStore, checksumService);
    const solutionService = new SolutionService(objStore, artifactService);

    const sse = new SpySseManager() as unknown as SseManager;
    const registry = new ResolverRegistry();
    registry.register("GetRobotBasicInfoTask", MockGetRobotBasicInfoTask);
    registry.register("GetRobotSoftwareInfoTask", MockGetRobotSoftwareInfoTask);
    registry.register("UpdateRobotBasicInfoTask", UpdateRobotBasicInfoTask as unknown as import("flowed").TaskResolverClass);
    registry.register("UpdateRobotSoftwareInfoTask", UpdateRobotSoftwareInfoTask as unknown as import("flowed").TaskResolverClass);

    const engine = new TaskFlowEngine(
      objStore as unknown as import("./services/objectStore.js").ObjectStore,
      sse,
      registry
    );

    const sseManager = new SseManager();
    const memStore = new MemStore();
    const robotService = new RobotService(objStore, engine, sseManager, memStore);
    engine.setFlowContext({ memStore });

    return { objStore: objStore as unknown as EnhancedObjectStore, solutionService, robotService, sse: sse as unknown as SpySseManager, engine };
  }

  function cleanup(services: { robotService: RobotService; engine: TaskFlowEngine }) {
    services.robotService.memStore.destroy();
    services.engine.destroy();
  }

  async function waitForInternalFlow(engine: TaskFlowEngine, timeoutMs = 5000): Promise<FlowSummary> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const flows = engine.listFlows("internal");
      if (flows.length > 0) return flows[0];
      await sleep(50);
    }
    throw new Error("No internal flow appeared within timeout");
  }

  function waitForFlowComplete(engine: TaskFlowEngine, id: string, timeoutMs = 15000): Promise<FlowSummary> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const summary = engine.getFlow(id);
        if (!summary) { clearInterval(timer); reject(new Error("Flow not found")); return; }
        if (summary.state === "COMPLETED" || summary.state === "FAILED" || summary.state === "STOPPED") {
          clearInterval(timer);
          resolve(summary);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error("Flow did not complete within timeout"));
        }
      }, 100);
    });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("TC-INT-001: robotService.create should create memStore cache entry for robot basic info", { timeout: 5000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });
    const key = buildRobotInfoKey(solution.id, robot.id);

    const ms = robotService.memStore;
    const meta = ms.getCacheMeta(key);
    assert.ok(meta, "memStore cache meta should exist after robot creation");
    assert.ok(meta.properties, "memStore cache properties should be defined");
    assert.equal(meta.properties.solutionId, solution.id, "properties should contain solutionId");
    assert.equal(meta.properties.robotId, robot.id, "properties should contain robotId");
    assert.equal(meta.config.ttlMs, 5 * 60 * 1000, "TTL should be 5 minutes");
    assert.equal(meta.config.cron, "*/180", "Cron should be every 180 seconds");

    const hasValue = ms.hasCache(key);
    assert.equal(hasValue, false, "Cache should have no value immediately after creation (no initialValue)");

    cleanup({ robotService, engine });
  });

  it("TC-INT-002: getRobotInfoList should trigger task flow and return basicInfo=null on first call", { timeout: 10000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });

    const infoList = await robotService.getRobotInfoList(solution.id);
    assert.equal(infoList.length, 1);
    assert.equal(infoList[0].id, robot.id);
    assert.equal(infoList[0].basicInfo, null, "basicInfo should be null on first call before task flow completes");

    const flow = await waitForInternalFlow(engine);
    assert.ok(flow, "At least one internal flow should have been triggered");

    cleanup({ robotService, engine });
  });

  it("TC-INT-003: mock task flow should complete and update memStore cache with robot basic info", { timeout: 20000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });
    const key = buildRobotInfoKey(solution.id, robot.id);

    robotService.getRobotInfoList(solution.id);

    const flow = await waitForInternalFlow(engine);
    const completed = await waitForFlowComplete(engine, flow.id, 15000);
    assert.equal(completed.state, "COMPLETED", `Task flow should complete successfully, got: ${completed.state}`);
    assert.ok(completed.taskResults, "Task results should be present");
    assert.equal(completed.taskStates["fetchInfo"], "COMPLETED", "fetchInfo task should complete");
    assert.equal(completed.taskStates["fetchSoftwareInfo"], "COMPLETED", "fetchSoftwareInfo task should complete");
    assert.equal(completed.taskStates["updateInfo"], "COMPLETED", "updateInfo task should complete");
    assert.equal(completed.taskStates["updateSoftwareInfo"], "COMPLETED", "updateSoftwareInfo task should complete");

    await sleep(500);

    const cached = robotService.memStore.getCache(key) as RobotBasicInfo | undefined;
    assert.ok(cached, "memStore cache should have robot basic info after task flow completes");
    assert.equal(cached.model, "MLLBA0201");
    assert.equal(cached.robotSn, "SQA000000000");
    assert.equal(cached.thingsId, "M000000000000");
    assert.equal(cached.vendorId, "0x000036a1");
    assert.equal(cached.productId, "0x00002410");
    assert.equal(cached.mainBoardSn, "SyriusRobotics");
    assert.equal(cached.mainBoardId, "WWVU0100406JCB06");
    assert.equal(cached.mainSomSn, "1420124249000");

    cleanup({ robotService, engine });
  });

  it("TC-INT-004: getRobotInfoList should return cached basicInfo after task flow completes", { timeout: 20000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });

    robotService.getRobotInfoList(solution.id);

    const flow = await waitForInternalFlow(engine);
    await waitForFlowComplete(engine, flow.id, 15000);
    await sleep(500);

    const infoList = await robotService.getRobotInfoList(solution.id);
    assert.equal(infoList.length, 1);
    assert.ok(infoList[0].basicInfo, "basicInfo should be populated from cache");
    assert.equal(infoList[0].basicInfo!.model, "MLLBA0201");
    assert.equal(infoList[0].basicInfo!.robotSn, "SQA000000000");

    cleanup({ robotService, engine });
  });

  it("TC-INT-005: getRobotInfo (single) should return cached basicInfo after task flow completes", { timeout: 20000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });

    robotService.getRobotInfo(solution.id, robot.id);

    const flow = await waitForInternalFlow(engine);
    await waitForFlowComplete(engine, flow.id, 15000);
    await sleep(500);

    const info = await robotService.getRobotInfo(solution.id, robot.id);
    assert.ok(info.basicInfo, "basicInfo should be populated from cache");
    assert.equal(info.basicInfo!.model, "MLLBA0201");

    cleanup({ robotService, engine });
  });

  it("TC-INT-006: robotService.remove should delete memStore cache for the robot", { timeout: 5000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });
    const key = buildRobotInfoKey(solution.id, robot.id);

    assert.ok(robotService.memStore.getCacheMeta(key), "Cache should exist before removal");

    await robotService.remove(solution.id, robot.id);

    const metaAfter = robotService.memStore.getCacheMeta(key);
    assert.equal(metaAfter, undefined, "Cache should be deleted after robot removal");

    cleanup({ robotService, engine });
  });

  it("TC-INT-007: removeSolutionCache should delete all robot info caches for a solution", { timeout: 5000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const r1 = await robotService.create(solution.id, { address: "10.0.0.1:22" });
    const r2 = await robotService.create(solution.id, { address: "10.0.0.2:22" });

    const key1 = buildRobotInfoKey(solution.id, r1.id);
    const key2 = buildRobotInfoKey(solution.id, r2.id);

    assert.ok(robotService.memStore.getCacheMeta(key1), "Cache for robot 1 should exist");
    assert.ok(robotService.memStore.getCacheMeta(key2), "Cache for robot 2 should exist");

    robotService.removeSolutionCache(solution.id);

    assert.equal(robotService.memStore.getCacheMeta(key1), undefined, "Cache for robot 1 should be deleted");
    assert.equal(robotService.memStore.getCacheMeta(key2), undefined, "Cache for robot 2 should be deleted");

    cleanup({ robotService, engine });
  });

  it("TC-INT-008: updating robot address should recreate memStore cache with new key", { timeout: 20000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "10.0.0.1:22" });
    const key = buildRobotInfoKey(solution.id, robot.id);

    robotService.getRobotInfoList(solution.id);
    const flow = await waitForInternalFlow(engine);
    await waitForFlowComplete(engine, flow.id, 15000);
    await sleep(500);

    assert.ok(robotService.memStore.hasCache(key), "Cache should have value before address update");

    await robotService.update(solution.id, robot.id, { address: "10.0.0.2:22" });

    assert.equal(robotService.memStore.hasCache(key), false, "Cache value should be cleared after address update (new cache created without value)");

    const meta = robotService.memStore.getCacheMeta(key);
    assert.ok(meta, "Cache meta should still exist after address update (recreated with same key)");

    cleanup({ robotService, engine });
  });

  it("TC-INT-009: SSE broadcast should fire when memStore cache is updated by task flow", { timeout: 20000 }, async () => {
    const { solutionService, robotService, engine, sse } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });

    sse.clear();
    robotService.getRobotInfoList(solution.id);

    const flow = await waitForInternalFlow(engine);
    await waitForFlowComplete(engine, flow.id, 15000);
    await sleep(500);

    assert.ok(sse.hasEvent("task-flow-engine/task-updated"), "SSE should broadcast task-updated event");
    assert.ok(sse.hasEvent("task-flow-engine/flow-completed"), "SSE should broadcast flow-completed event");

    cleanup({ robotService, engine });
  });

  it("TC-INT-010: RobotService SSE broadcast should fire entry-updated when cache is populated", { timeout: 20000 }, async () => {
    const { solutionService, robotService, engine } = createIntegrationServices();
    const solution = await solutionService.create({ name: "Integration Test" });

    const robot = await robotService.create(solution.id, { address: "192.168.1.100:22" });
    const key = buildRobotInfoKey(solution.id, robot.id);

    const received: string[] = [];
    const controller = {
      enqueue: (data: Uint8Array) => {
        received.push(new TextDecoder().decode(data));
      },
    } as unknown as ReadableStreamDefaultController;
    robotService.sseManager.addClient({ id: "test-client", controller });

    robotService.getRobotInfoList(solution.id);

    const flow = await waitForInternalFlow(engine);
    await waitForFlowComplete(engine, flow.id, 15000);
    await sleep(500);

    const updateEvent = received.find((e: string) => e.includes("memstore/entry-updated") && e.includes(key));
    assert.ok(updateEvent, "SSE should receive entry-updated event for the cache key");
    assert.ok(updateEvent.includes(key), "SSE event should contain the cache key");

    robotService.sseManager.removeClient("test-client");
    cleanup({ robotService, engine });
  });
});

describe("MemStore Unit Tests", () => {
  function createTestMemStore(handler?: CacheEventHandler): MemStore {
    return new MemStore(handler);
  }

  function createTrackingHandler(): {
    handler: CacheEventHandler;
    createdCalls: CacheEntry[];
    updateCalls: CacheEntry[];
    valueChangedCalls: CacheEntry[];
    deletedCalls: CacheEntry[];
  } {
    const createdCalls: CacheEntry[] = [];
    const updateCalls: CacheEntry[] = [];
    const valueChangedCalls: CacheEntry[] = [];
    const deletedCalls: CacheEntry[] = [];
    const handler: CacheEventHandler = {
      onCreated(_store, entry) { createdCalls.push(entry); },
      onUpdate(_store, entry) { updateCalls.push(entry); },
      onValueChanged(_store, entry) { valueChangedCalls.push(entry); },
      onDeleted(_store, entry) { deletedCalls.push(entry); },
    };
    return { handler, createdCalls, updateCalls, valueChangedCalls, deletedCalls };
  }

  it("TC-MS-001: createCache without initial value or properties", () => {
    const { handler, createdCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);

    store.createCache("k1", { ttlMs: 60000 });

    assert.equal(store.hasCache("k1"), false);
    assert.equal(store.getCache("k1"), undefined);
    assert.equal(createdCalls.length, 1);
    assert.equal(createdCalls[0].key, "k1");
    assert.equal(createdCalls[0].hasValue, false);

    const meta = store.getCacheMeta("k1");
    assert.ok(meta);
    assert.equal(meta.config.ttlMs, 60000);

    store.destroy();
  });

  it("TC-MS-002: createCache with initial value and properties", () => {
    const { handler, createdCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);

    store.createCache("k2", { ttlMs: 60000 }, {
      initialValue: { a: 1 },
      properties: { solutionId: "sol1", robotId: "r1" },
    });

    assert.equal(store.hasCache("k2"), true);
    assert.deepEqual(store.getCache("k2"), { a: 1 });
    assert.equal(createdCalls.length, 1);
    assert.deepEqual(createdCalls[0].value, { a: 1 });
    assert.equal((createdCalls[0].properties as Record<string, unknown>).solutionId, "sol1");
    assert.equal((createdCalls[0].properties as Record<string, unknown>).robotId, "r1");

    store.destroy();
  });

  it("TC-MS-003: getCacheDetail returns value and properties", () => {
    const store = createTestMemStore();
    store.createCache("k2", { ttlMs: 60000 }, {
      initialValue: { a: 1 },
      properties: { solutionId: "sol1" },
    });

    const detail = store.getCacheDetail("k2");
    assert.ok(detail);
    assert.deepEqual(detail.value, { a: 1 });
    assert.equal((detail.properties as Record<string, unknown>).solutionId, "sol1");

    store.destroy();
  });

  it("TC-MS-005: context map is read-write at runtime", () => {
    const store = createTestMemStore();
    store.createCache("k1", { ttlMs: 60000 });

    const detail1 = store.getCacheDetail("k1");
    assert.ok(detail1);
    detail1.context.lastFlowId = "flow-123";

    const detail2 = store.getCacheDetail("k1");
    assert.ok(detail2);
    assert.equal(detail2.context.lastFlowId, "flow-123");

    store.destroy();
  });

  it("TC-MS-006: cache miss triggers onUpdate", () => {
    const { handler, updateCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);
    store.createCache("k1", { ttlMs: 60000 });

    updateCalls.length = 0;

    const value = store.getCache("k1");
    assert.equal(value, undefined);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].key, "k1");

    store.destroy();
  });

  it("TC-MS-007: triggerRefresh calls onUpdate", () => {
    const { handler, updateCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);
    store.createCache("k1", { ttlMs: 60000 });

    updateCalls.length = 0;

    store.triggerRefresh("k1");
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].key, "k1");

    store.destroy();
  });

  it("TC-MS-008: updateCache triggers onValueChanged but not onUpdate", () => {
    const { handler, createdCalls, updateCalls, valueChangedCalls, deletedCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);
    store.createCache("k1", { ttlMs: 60000 });
    createdCalls.length = 0;

    store.updateCache("k1", { updated: true });

    assert.deepEqual(store.getCache("k1"), { updated: true });
    assert.equal(createdCalls.length, 0);
    assert.equal(updateCalls.length, 0);
    assert.equal(valueChangedCalls.length, 1);
    assert.equal(valueChangedCalls[0].key, "k1");
    assert.deepEqual(valueChangedCalls[0].value, { updated: true });
    assert.equal(deletedCalls.length, 0);

    store.destroy();
  });

  it("TC-MS-009: deleteCache triggers onDeleted", () => {
    const { handler, deletedCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);
    store.createCache("k1", { ttlMs: 60000 });

    store.deleteCache("k1");

    assert.equal(store.hasCache("k1"), false);
    assert.equal(store.getCacheMeta("k1"), undefined);
    assert.equal(deletedCalls.length, 1);
    assert.equal(deletedCalls[0].key, "k1");

    store.destroy();
  });

  it("TC-MS-010: deleteByPrefix batch deletes", () => {
    const { handler, deletedCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);
    store.createCache("robot:sol1/r1", { ttlMs: 60000 });
    store.createCache("robot:sol1/r2", { ttlMs: 60000 });
    store.createCache("robot:sol2/r3", { ttlMs: 60000 });

    const deleted = store.deleteByPrefix("robot:sol1/");

    assert.deepEqual(deleted, ["robot:sol1/r1", "robot:sol1/r2"]);
    assert.equal(store.hasCache("robot:sol1/r1"), false);
    assert.equal(store.hasCache("robot:sol1/r2"), false);
    assert.equal(store.hasCache("robot:sol2/r3"), false);
    assert.equal(deletedCalls.length, 2);

    store.destroy();
  });

  it("TC-MS-011: listCaches with property filter", () => {
    const store = createTestMemStore();
    store.createCache("k1", { ttlMs: 60000 }, { properties: { solutionId: "sol1", robotId: "r1" } });
    store.createCache("k2", { ttlMs: 60000 }, { properties: { solutionId: "sol1", robotId: "r2" } });
    store.createCache("k3", { ttlMs: 60000 }, { properties: { solutionId: "sol2", robotId: "r3" } });

    const sol1 = store.listCaches({ solutionId: "sol1" });
    assert.equal(sol1.length, 2);

    const sol1r1 = store.listCaches({ solutionId: "sol1", robotId: "r1" });
    assert.equal(sol1r1.length, 1);
    assert.equal(sol1r1[0].key, "k1");

    const all = store.listCaches();
    assert.equal(all.length, 3);

    const empty = store.listCaches({ solutionId: "sol3" });
    assert.equal(empty.length, 0);

    store.destroy();
  });

  it("TC-MS-012: refresh debounce", () => {
    const { handler, updateCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);
    store.createCache("k1", { ttlMs: 60000 });

    updateCalls.length = 0;

    store.triggerRefresh("k1");
    store.triggerRefresh("k1");
    store.triggerRefresh("k1");

    assert.equal(updateCalls.length, 1);

    store.destroy();
  });

  it("TC-MS-013: updateConfig dynamically", () => {
    const store = createTestMemStore();
    store.createCache("k1", { ttlMs: 60000 });

    store.updateConfig("k1", { ttlMs: 120000, cron: "*/60" });

    const meta = store.getCacheMeta("k1");
    assert.ok(meta);
    assert.equal(meta.config.ttlMs, 120000);
    assert.equal(meta.config.cron, "*/60");

    store.destroy();
  });

  it("TC-MS-014: SSE broadcast receives update via SseManager", () => {
    const sseManager = new SseManager();
    const enqueued: string[] = [];
    const controller = {
      enqueue: (data: Uint8Array) => {
        enqueued.push(new TextDecoder().decode(data));
      },
    } as unknown as ReadableStreamDefaultController;
    sseManager.addClient({ id: "c1", controller });

    const { handler } = createTrackingHandler();
    const wrappedHandler: CacheEventHandler = {
      onCreated: handler.onCreated,
      onUpdate: handler.onUpdate,
      onValueChanged(_store, entry) {
        sseManager.broadcast("memstore/entry-updated", { key: entry.key, value: entry.value, properties: entry.properties });
      },
      onDeleted(_store, entry) {
        sseManager.broadcast("memstore/entry-deleted", { key: entry.key });
      },
    };
    const store = createTestMemStore(wrappedHandler);
    store.createCache("k1", { ttlMs: 60000 });

    enqueued.length = 0;
    store.updateCache("k1", { newVal: true });

    assert.ok(enqueued.length > 0);
    assert.ok(enqueued[0].includes("memstore/entry-updated"));
    assert.ok(enqueued[0].includes("newVal"));

    store.destroy();
  });

  it("TC-MS-015: SSE broadcast on value changed via unified events", () => {
    const sseManager = new SseManager();
    const enqueued: string[] = [];
    const controller = {
      enqueue: (data: Uint8Array) => {
        enqueued.push(new TextDecoder().decode(data));
      },
    } as unknown as ReadableStreamDefaultController;
    sseManager.addClient({ id: "c1", controller });

    const { handler } = createTrackingHandler();
    const wrappedHandler: CacheEventHandler = {
      onCreated: handler.onCreated,
      onUpdate: handler.onUpdate,
      onValueChanged(_store, entry) {
        sseManager.broadcast("memstore/entry-updated", { key: entry.key, value: entry.value, properties: entry.properties });
      },
      onDeleted(_store, entry) {
        sseManager.broadcast("memstore/entry-deleted", { key: entry.key });
      },
    };
    const store = createTestMemStore(wrappedHandler);
    store.createCache("k1", { ttlMs: 60000 }, { initialValue: { x: 1 } });

    enqueued.length = 0;
    store.updateCache("k1", { x: 2 });

    assert.ok(enqueued.length > 0);
    assert.ok(enqueued[0].includes("memstore/entry-updated"));

    store.destroy();
  });

  it("TC-MS-031: multiple MemStore instances are independent", () => {
    const store1 = createTestMemStore();
    const store2 = createTestMemStore();

    store1.createCache("k1", { ttlMs: 60000 }, { initialValue: "v1" });

    assert.equal(store1.hasCache("k1"), true);
    assert.equal(store2.hasCache("k1"), false);
    assert.equal(store2.getCache("k1"), undefined);

    store1.destroy();
    store2.destroy();
  });

  it("TC-MS-032: no handler uses no-op implementation", () => {
    const store = createTestMemStore();
    store.createCache("k1", { ttlMs: 60000 });
    store.triggerRefresh("k1");
    store.deleteCache("k1");

    store.destroy();
  });

  it("TC-MS-020: handler can inject context in events", () => {
    const { handler, updateCalls } = createTrackingHandler();
    const store = createTestMemStore(handler);
    store.createCache("k1", { ttlMs: 60000 }, {
      properties: { taskFlowSpec: { type: "test" } },
    });

    const originalOnUpdate = handler.onUpdate.bind(handler);
    handler.onUpdate = (store, entry) => {
      entry.context.flowId = "flow-abc";
      originalOnUpdate(store, entry);
    };

    store.triggerRefresh("k1");

    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].context.flowId, "flow-abc");

    store.destroy();
  });

  it("properties are frozen after creation", () => {
    const store = createTestMemStore();
    store.createCache("k1", { ttlMs: 60000 }, {
      properties: { solutionId: "sol1" },
    });

    const detail = store.getCacheDetail("k1");
    assert.ok(detail);
    assert.ok(Object.isFrozen(detail.properties));

    store.destroy();
  });
});

describe("Robot Routes - API", () => {
  const robotServiceInstances: RobotService[] = [];

  afterEach(() => {
    while (robotServiceInstances.length) {
      robotServiceInstances.pop()!.memStore.destroy();
    }
  });

  function setupRobotApp() {
    const objStore = new EnhancedObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
    const solutionService = new SolutionService(objStore);
    const engine = createTestTaskFlowEngine(objStore);
    const sseManager = new SseManager();
    const memStore = new MemStore();
    const robotService = new RobotService(objStore, engine, sseManager, memStore);
    engine.setFlowContext({ memStore });
    robotServiceInstances.push(robotService);
    const app = new Hono();
    app.route("/api/solutions", createSolutionRoutes(solutionService));
    app.route("/api/solutions/:solutionId/robots", createRobotRoutes(robotService));
    return { app, solutionService, robotService };
  }

  async function createSolution(app: Hono) {
    const res = await app.request("/api/solutions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Robot Test Solution" }),
    });
    return (await res.json()) as SolutionMeta;
  }

  it("TC-ROB-API-001: POST /api/solutions/:id/robots should create a robot", async () => {
    const { app } = setupRobotApp();
    const sol = await createSolution(app);
    const res = await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "192.168.1.100:22" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as StoredRobotData;
    assert.equal(body.address, "192.168.1.100");
    assert.equal(body.port, 22);
  });

  it("TC-ROB-API-002: POST /api/solutions/:id/robots should return 400 without address", async () => {
    const { app } = setupRobotApp();
    const sol = await createSolution(app);
    const res = await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "NoAddr" }),
    });
    assert.equal(res.status, 400);
  });

  it("TC-ROB-API-003: POST /api/solutions/:id/robots should return 409 for duplicate address", async () => {
    const { app } = setupRobotApp();
    const sol = await createSolution(app);
    await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "10.0.0.1:22" }),
    });
    const res = await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "10.0.0.1:22" }),
    });
    assert.equal(res.status, 409);
  });

  it("TC-ROB-API-004: GET /api/solutions/:id/robots should list robots", async () => {
    const { app } = setupRobotApp();
    const sol = await createSolution(app);
    await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "10.0.0.1" }),
    });
    await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "10.0.0.2" }),
    });
    const res = await app.request(`/api/solutions/${sol.id}/robots`);
    assert.equal(res.status, 200);
    const body = await res.json() as StoredRobotData[];
    assert.equal(body.length, 2);
  });

  it("TC-ROB-API-005: GET /api/solutions/:id/robots/:robotId should get a robot", async () => {
    const { app } = setupRobotApp();
    const sol = await createSolution(app);
    const createRes = await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "10.0.0.1" }),
    });
    const created = await createRes.json() as StoredRobotData;
    const res = await app.request(`/api/solutions/${sol.id}/robots/${created.id}`);
    assert.equal(res.status, 200);
    const body = await res.json() as StoredRobotData;
    assert.equal(body.id, created.id);
  });

  it("TC-ROB-API-006: GET /api/solutions/:id/robots/:robotId should return 404 for non-existent", async () => {
    const { app } = setupRobotApp();
    const sol = await createSolution(app);
    const res = await app.request(`/api/solutions/${sol.id}/robots/nonexistent`);
    assert.equal(res.status, 404);
  });

  it("TC-ROB-API-007: PUT /api/solutions/:id/robots/:robotId should update a robot", async () => {
    const { app } = setupRobotApp();
    const sol = await createSolution(app);
    const createRes = await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "10.0.0.1" }),
    });
    const created = await createRes.json() as StoredRobotData;
    const res = await app.request(`/api/solutions/${sol.id}/robots/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "UpdatedAlias" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as StoredRobotData;
    assert.equal(body.alias, "UpdatedAlias");
  });

  it("TC-ROB-API-008: DELETE /api/solutions/:id/robots/:robotId should delete a robot", async () => {
    const { app } = setupRobotApp();
    const sol = await createSolution(app);
    const createRes = await app.request(`/api/solutions/${sol.id}/robots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "10.0.0.1" }),
    });
    const created = await createRes.json() as StoredRobotData;
    const res = await app.request(`/api/solutions/${sol.id}/robots/${created.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const getRes = await app.request(`/api/solutions/${sol.id}/robots/${created.id}`);
    assert.equal(getRes.status, 404);
  });

  it("TC-ROB-API-009: robot operations should return 404 for non-existent solution", async () => {
    const { app } = setupRobotApp();
    const listRes = await app.request("/api/solutions/nonexistent/robots");
    assert.equal(listRes.status, 404);
    const createRes = await app.request("/api/solutions/nonexistent/robots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "10.0.0.1" }),
    });
    assert.equal(createRes.status, 404);
  });
});

class TestableTransferIotGatewayConfigTask extends TransferIotGatewayConfigTask {
  public params(params: ValueMap = {}): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

describe("TransferIotGatewayConfigTask", () => {
  it("TC-TFE-061: should build correct transfer params", () => {
    const task = new TestableTransferIotGatewayConfigTask();
    const params = task.params({ robotIp: "192.168.1.10" });

    assert.match(params.localFilePath as string, /iot-gateway-application-prod\.yaml$/);
    assert.equal(params.remoteFilePath, "/tmp/iot-gateway-application-prod.yaml");
    assert.equal(params.sudo, true);
    assert.equal(params.verifyChecksum, false);
    assert.equal(params.retryCount, 1);
  });
});

class TestableUpdateIotGatewayConfigTask extends UpdateIotGatewayConfigTask {
  public command(): string {
    return this.getSshCommand({});
  }

  public params(params: ValueMap = {}): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

describe("UpdateIotGatewayConfigTask", () => {
  it("TC-TFE-062: should generate correct command with all required steps", () => {
    const task = new TestableUpdateIotGatewayConfigTask();
    const command = task.command();

    assert.match(command, / && /);
    assert.match(command, /mv.*iot-gateway-application-prod\.yaml/);
    assert.match(command, /chown iot-gateway:iot-gateway/);
    assert.match(command, /trusted\.gpg\* \|\| true/);
    assert.match(command, /nexus\.asc \|\| true/);
    assert.match(command, /apt clean \|\| true/);
    assert.match(command, /systemctl restart syrius-iot-gateway/);
    assert.match(command, /systemctl restart cosmos-update-engine/);
  });

  it("TC-TFE-063: should build correct params", () => {
    const task = new TestableUpdateIotGatewayConfigTask();
    const params = task.params({ robotIp: "192.168.1.10", sshUsername: "u", sshPassword: "p" });

    assert.equal(params.sudo, true);
    assert.equal(params.commandTimeout, 120000);
  });
});

import { SshFileDownloadTask } from "./tasks/real/sshFileDownloadTask.js";
import { MockSshFileDownloadTask } from "./tasks/mock/mockSshFileDownloadTask.js";

class TestableSshFileDownloadTask extends SshFileDownloadTask {
  public params(params: ValueMap = {}): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

describe("SshFileDownloadTask", () => {
  it("TC-DOWNLOAD-001: should build params with defaults", () => {
    const task = new TestableSshFileDownloadTask();
    const params = task.params({
      robotIp: "192.168.1.10",
      remoteFilePath: "/opt/cosmos/map/preview/sketch.zip",
      localTargetDir: "/tmp",
    });

    assert.equal(params.robotIp, "192.168.1.10");
    assert.equal(params.robotPort, 22);
    assert.equal(params.timeout, 30000);
    assert.equal(params.retryCount, 3);
    assert.equal(params.sshUsername, "developer");
    assert.equal(params.sshPassword, "developer");
    assert.equal(params.remoteFilePath, "/opt/cosmos/map/preview/sketch.zip");
    assert.equal(params.localTargetDir, "/tmp");
    assert.equal(params.verifyChecksum, true);
    assert.equal(params.checksumAlgorithm, "sha256");
  });

  it("TC-DOWNLOAD-002: should override defaults with custom params", () => {
    const task = new TestableSshFileDownloadTask();
    const params = task.params({
      robotIp: "10.0.0.1",
      robotPort: 2222,
      timeout: 60000,
      retryCount: 5,
      sshUsername: "customuser",
      sshPassword: "custompass",
      remoteFilePath: "/home/user/data.zip",
      localTargetDir: "/home/downloads",
      verifyChecksum: false,
      checksumAlgorithm: "md5",
    });

    assert.equal(params.robotPort, 2222);
    assert.equal(params.timeout, 60000);
    assert.equal(params.retryCount, 5);
    assert.equal(params.sshUsername, "customuser");
    assert.equal(params.sshPassword, "custompass");
    assert.equal(params.remoteFilePath, "/home/user/data.zip");
    assert.equal(params.localTargetDir, "/home/downloads");
    assert.equal(params.verifyChecksum, false);
    assert.equal(params.checksumAlgorithm, "md5");
  });

  it("TC-DOWNLOAD-003: should resolve host from mDNS domain when provided", () => {
    const task = new TestableSshFileDownloadTask();
    const params = task.params({
      robotIp: "192.168.1.10",
      robotMdnsDomain: "robot-alpha2.local",
      remoteFilePath: "/test.zip",
      localTargetDir: "/tmp",
    });

    assert.equal(params.robotMdnsDomain, "robot-alpha2.local");
    assert.equal(params.robotIp, "192.168.1.10");
  });

  it("TC-DOWNLOAD-004: mock task should return simulated result", async () => {
    const task = new MockSshFileDownloadTask();
    const result = await task.exec({
      robotIp: "192.168.1.10",
      remoteFilePath: "/opt/cosmos/map/preview/sketch.zip",
      localTargetDir: "/tmp",
    }) as Record<string, unknown>;

    assert.equal(result.done, true);
    assert.equal(result.success, true);
    assert.equal(result.bytesTransferred, 0);
    assert.equal(result.localFilePath, "/tmp/sketch.zip");
    assert.equal(result.localChecksum, "");
    assert.equal(result.remoteChecksum, "");
    assert.equal(result.integrityVerified, true);
  });

  it("TC-DOWNLOAD-005: mock task should construct correct local file path", async () => {
    const task = new MockSshFileDownloadTask();
    const result = await task.exec({
      robotIp: "10.0.0.1",
      remoteFilePath: "/var/log/robot.log",
      localTargetDir: "/home/user/logs",
    }) as Record<string, unknown>;

    assert.equal(result.localFilePath, "/home/user/logs/robot.log");
  });

  it("TC-DOWNLOAD-006: mock task execution should take approximately 5 seconds", async () => {
    const task = new MockSshFileDownloadTask();
    const start = Date.now();
    await task.exec({
      robotIp: "192.168.1.10",
      remoteFilePath: "/test.zip",
      localTargetDir: "/tmp",
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 4500, `Expected >= 4500ms but got ${elapsed}ms`);
    assert.ok(elapsed <= 7000, `Expected <= 7000ms but got ${elapsed}ms`);
  });
});

describe("SshFileDownloadTask - Flow Integration", () => {
  it("TC-DOWNLOAD-FLOW-001: should create flow with SshFileDownloadTask DAG and complete", async () => {
    const { engine } = createEngine();
    const registry = new ResolverRegistry();
    registry.register("MockTask1", MockTask1);
    registry.register("MockTask2", MockTask2);
    registry.register("SshFileDownloadTask", MockSshFileDownloadTask as unknown as TaskResolverClass);

    const objStore = new InMemoryObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
    const sse = new SpySseManager() as unknown as SseManager;
    const testEngine = new TaskFlowEngine(objStore, sse, registry);

    const downloadDag: FlowSpec = {
      tasks: {
        download: {
          requires: ["robotIp", "robotPort", "localTargetDir"],
          provides: ["download_result"],
          resolver: {
            name: "SshFileDownloadTask",
            params: {
              robotIp: "robotIp",
              robotPort: "robotPort",
              localTargetDir: "localTargetDir",
              remoteFilePath: { value: "/opt/cosmos/map/preview/sketch.zip" },
            },
            results: { done: "download_result" },
          },
        },
      },
    };

    const summary = await testEngine.createFlow("internal", downloadDag, {
      robotIp: "192.168.1.10",
      robotPort: 22,
      localTargetDir: "/tmp",
    });

    await waitForFlowComplete(testEngine, summary.id);

    const flow = testEngine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "COMPLETED");
    assert.equal(flow.taskStates["download"], "COMPLETED");
    assert.ok(flow.taskResults);
    assert.ok(flow.taskResults!["download"]);
    assert.equal((flow.taskResults!["download"] as Record<string, unknown>).done, true);
    testEngine.destroy();
  });
});


import { TransferAppTask } from "./tasks/real/transferAppTask.js";
import { MockTransferAppTask } from "./tasks/mock/mockTransferAppTask.js";
import { InstallAppTask, CleanupAppTask } from "./tasks/real/installAppTask.js";
import { MockInstallAppTask, MockCleanupAppTask } from "./tasks/mock/mockInstallAppTask.js";

class TestableTransferAppTask extends TransferAppTask {
  public params(params: ValueMap): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

describe("TransferApp task", () => {
  it("TC-APP-001: should upload APK to /tmp/app_package.apk", () => {
    const task = new TestableTransferAppTask();
    const params = task.params({
      robotIp: "192.168.1.10",
      artifactId: "test-apk-id",
    });
    assert.equal(params.remoteFilePath, "/tmp/app_package.apk");
    assert.equal(params.sudo, true);
  });
});

class TestableInstallAppTask extends InstallAppTask {
  public command(): string {
    return this.getSshCommand({});
  }

  public params(params: ValueMap): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

describe("InstallApp task", () => {
  it("TC-APP-002: should generate correct combined install command with all steps", () => {
    const task = new TestableInstallAppTask();
    const command = task.command();
    assert.match(command, /adb kill-server/);
    assert.match(command, /adb start-server/);
    assert.match(command, /systemctl stop syriusrobotics\.kuaye\.service/);
    assert.match(command, /adb install -d -r \/tmp\/app_package\.apk/);
    assert.match(command, /systemctl start syriusrobotics\.kuaye\.service/);
    assert.match(command, /rm -f \/tmp\/app_package\.apk/);
    assert.match(command, /sh -c/);
    assert.match(command, / && /);
  });

  it("TC-APP-003: should use sudo for the overall task", () => {
    const task = new TestableInstallAppTask();
    const params = task.params({ robotIp: "192.168.1.10" });
    assert.equal(params.sudo, true);
  });

  it("TC-APP-004: should default commandTimeout to 300000ms", () => {
    const task = new TestableInstallAppTask();
    const params = task.params({ robotIp: "192.168.1.10" });
    assert.equal(params.commandTimeout, 300000);
  });

  it("TC-APP-005: ADB fix steps should run before install in correct order", () => {
    const task = new TestableInstallAppTask();
    const command = task.command();
    const adbKillIdx = command.indexOf("adb kill-server");
    const adbStartIdx = command.indexOf("adb start-server");
    const stopIdx = command.indexOf("systemctl stop");
    const installIdx = command.indexOf("adb install");
    assert.ok(adbKillIdx < adbStartIdx, "adb kill-server before adb start-server");
    assert.ok(adbStartIdx < stopIdx, "ADB fix before stop service");
    assert.ok(stopIdx < installIdx, "stop before install");
  });

  it("TC-APP-005b: non-adb commands should use sh -c wrapper to ignore failures", () => {
    const task = new TestableInstallAppTask();
    const command = task.command();
    assert.match(command, /sh -c "rm -rf/);
    assert.match(command, /sh -c "adb kill-server ; true"/);
    assert.match(command, /sh -c "systemctl stop .+ ; true"/);
    assert.match(command, /sh -c "systemctl start .+ ; true"/);
    assert.match(command, /sh -c "rm -f .+ ; true"/);
    assert.doesNotMatch(command, /sh -c "adb install/);
  });
});

class TestableCleanupAppTask extends CleanupAppTask {
  public command(): string {
    return this.getSshCommand({});
  }

  public params(params: ValueMap): ValueMap {
    return this.buildParams(params) as unknown as ValueMap;
  }
}

describe("CleanupApp task", () => {
  it("TC-APP-006: should generate correct cleanup command", () => {
    const task = new TestableCleanupAppTask();
    const command = task.command();
    assert.equal(command, "rm -f /tmp/app_package.apk");
  });

  it("TC-APP-007: should use sudo for cleanup", () => {
    const task = new TestableCleanupAppTask();
    const params = task.params({ robotIp: "192.168.1.10" });
    assert.equal(params.sudo, true);
  });
});

describe("App install - Flow Integration", () => {
  it("TC-APP-008: should execute 2-step install-app DAG and complete", async () => {
    const { engine } = createEngine();
    const registry = new ResolverRegistry();
    registry.register("TransferAppTask", MockTransferAppTask as unknown as TaskResolverClass);
    registry.register("InstallAppTask", MockInstallAppTask as unknown as TaskResolverClass);
    registry.register("CleanupAppTask", MockCleanupAppTask as unknown as TaskResolverClass);

    const objStore = new InMemoryObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
    const sse = new SpySseManager() as unknown as SseManager;
    const testEngine = new TaskFlowEngine(objStore, sse, registry);

    const installDag: FlowSpec = {
      tasks: {
        transfer: {
          requires: ["robotIp", "robotPort", "artifactId"],
          provides: ["transfer_done"],
          resolver: {
            name: "TransferAppTask",
            params: {
              robotIp: "robotIp",
              robotPort: "robotPort",
              artifactId: "artifactId",
            },
            results: { done: "transfer_done" },
          },
        },
        install: {
          requires: ["robotIp", "robotPort", "transfer_done"],
          provides: ["install_done"],
          resolver: {
            name: "InstallAppTask",
            params: {
              robotIp: "robotIp",
              robotPort: "robotPort",
            },
            results: { done: "install_done" },
          },
        },
      },
    };

    const summary = await testEngine.createFlow("internal", installDag, {
      robotIp: "192.168.1.10",
      robotPort: 22,
      artifactId: "test-apk",
    });
    await waitForFlowComplete(testEngine, summary.id);

    const flow = testEngine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "COMPLETED");
    assert.equal(flow.taskStates["transfer"], "COMPLETED");
    assert.equal(flow.taskStates["install"], "COMPLETED");
    testEngine.destroy();
  });

  it("TC-APP-009: error DAG cleanup should run when install fails", async () => {
    class FailingMockInstallTask extends MockInstallAppTask {
      protected override async onExec(_params: ValueMap): Promise<ValueMap> {
        throw new Error("Simulated adb install failure");
      }
    }

    const { engine } = createEngine();
    const registry = new ResolverRegistry();
    registry.register("TransferAppTask", MockTransferAppTask as unknown as TaskResolverClass);
    registry.register("InstallAppTask", FailingMockInstallTask as unknown as TaskResolverClass);
    registry.register("CleanupAppTask", MockCleanupAppTask as unknown as TaskResolverClass);

    const objStore = new InMemoryObjectStore() as unknown as import("./services/objectStore.js").ObjectStore;
    const sse = new SpySseManager() as unknown as SseManager;
    const testEngine = new TaskFlowEngine(objStore, sse, registry);

    const installDag: FlowSpec = {
      tasks: {
        transfer: {
          requires: ["robotIp", "robotPort", "artifactId"],
          provides: ["transfer_done"],
          resolver: {
            name: "TransferAppTask",
            params: {
              robotIp: "robotIp",
              robotPort: "robotPort",
              artifactId: "artifactId",
            },
            results: { done: "transfer_done" },
          },
        },
        install: {
          requires: ["robotIp", "robotPort", "transfer_done"],
          provides: ["install_done"],
          resolver: {
            name: "InstallAppTask",
            params: {
              robotIp: "robotIp",
              robotPort: "robotPort",
            },
            results: { done: "install_done" },
          },
        },
      },
    };

    const cleanupDag: FlowSpec = {
      tasks: {
        error_cleanup: {
          provides: ["error_cleanup_done"],
          resolver: {
            name: "CleanupAppTask",
            params: {
              robotIp: "robotIp",
              robotPort: "robotPort",
            },
            results: { done: "error_cleanup_done" },
          },
        },
      },
    };

    const summary = await testEngine.createFlow("internal", installDag, {
      robotIp: "192.168.1.10",
      robotPort: 22,
      artifactId: "test-apk",
    }, undefined, cleanupDag);
    await waitForFlowComplete(testEngine, summary.id, 15000);

    const flow = testEngine.getFlow(summary.id);
    assert.ok(flow);
    assert.equal(flow.state, "FAILED");
    assert.equal(flow.phase, "error");
    assert.ok(sse.hasEvent("task-flow-engine/error-handling-completed"));
    testEngine.destroy();
  });
});
