import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { ObjectStore } from "./services/objectStore.js";
import { ChecksumService } from "./services/checksumService.js";
import { ArtifactService } from "./services/artifactService.js";
import { SolutionService } from "./services/solutionService.js";
import { RobotService } from "./services/robotService.js";
import { createObjectStoreRoutes } from "./routes/objectStoreRoutes.js";
import { createArtifactRoutes } from "./routes/artifactRoutes.js";
import { createSolutionRoutes } from "./routes/solutionRoutes.js";
import { createRobotRoutes } from "./routes/robotRoutes.js";
import { createMemStoreRoutes } from "./routes/memStoreRoutes.js";
import { createTaskFlowRoutes } from "./routes/taskFlowRoutes.js";
import { createSseRoutes } from "./routes/sseRoutes.js";
import { createSystemLogRoutes } from "./routes/systemLogRoutes.js";
import { AppError } from "./errors/appErrors.js";
import * as store from "./objectStore/store.js";
import { TaskFlowEngine, ResolverRegistry, SseManager } from "./services/taskFlowEngine/index.js";
import type { TaskResolverClass } from "flowed";
import { SshCommandTask, MockSshCommandTask, GetRobotBasicInfoTask, MockGetRobotBasicInfoTask, GetRobotSoftwareInfoTask, MockGetRobotSoftwareInfoTask, UpdateRobotBasicInfoTask, MockUpdateRobotBasicInfoTask, UpdateRobotSoftwareInfoTask, MockUpdateRobotSoftwareInfoTask, SshFileTransferTask, MockSshFileTransferTask, UpgradeMovebaseTask, MockUpgradeMovebaseTask, TransferMovebaseTask, MockTransferMovebaseTask, DeleteMovebaseTask, MockDeleteMovebaseTask, RebootRobotTask, MockRebootRobotTask, MatchFileContentTask, MockMatchFileContentTask, MatchMovebaseVersionTask, MockMatchMovebaseVersionTask, TransferBUPTask, MockTransferBUPTask, TransferBUPScriptTask, MockTransferBUPScriptTask, UpgradeBUPTask, MockUpgradeBUPTask, MatchBUPVersionTask, MockMatchBUPVersionTask, DeleteBUPTask, MockDeleteBUPTask, MovebaseDiskCleanupTask, MockMovebaseDiskCleanupTask, TransferAlpha2MapTask, MockTransferAlpha2MapTask, ApplyAlpha2MapTask, MockApplyAlpha2MapTask, DeleteAlpha2MapTask, MockDeleteAlpha2MapTask, SleepTask, MockSleepTask, WaitSshConnectedTask, MockWaitSshConnectedTask, WaitSshDisconnectedTask, MockWaitSshDisconnectedTask, WaitSshReconnectTask, MockWaitSshReconnectTask, TransferIotGatewayConfigTask, MockTransferIotGatewayConfigTask, UpdateIotGatewayConfigTask, MockUpdateIotGatewayConfigTask, SshFileDownloadTask, MockSshFileDownloadTask, TransferAEConfigTask, MockTransferAEConfigTask, DeployAEConfigTask, MockDeployAEConfigTask, DeleteAEConfigTask, MockDeleteAEConfigTask, TransferAppTask, MockTransferAppTask, InstallAppTask, CleanupAppTask, MockInstallAppTask, MockCleanupAppTask } from "./tasks/index.js";
import { MemStore } from "./memStore/index.js";
import { SystemLogService } from "./services/systemLogService.js";
import { SSH_USERNAME, SSH_PASSWORD } from "./config.js";
import { configureLogger, createLogger } from "./logger/index.js";
import { loadAppConfig, parseCliArgs, resolveRuntimePaths, isPkgRuntime } from "./runtime/appConfig.js";
import { StaticAssetService } from "./static/staticAssetService.js";
import { createStaticRoutes } from "./static/staticRoutes.js";
import { exec } from "node:child_process";

const startupLog = createLogger("App");

function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  exec(command, (err) => {
    if (err) {
      startupLog.warn({ err: err.message, url }, "Failed to open browser");
    }
  });
}

async function main(): Promise<void> {
  const cliOverrides = parseCliArgs();
  const runtimePaths = resolveRuntimePaths();

  if (cliOverrides.version) {
    process.stdout.write("1.0.0\n");
    process.exit(0);
  }

  const { config, configLoaded } = await loadAppConfig(runtimePaths, cliOverrides);
  configureLogger({ level: config.logs.level, logsDir: config.logs.dir });
  const log = createLogger("App");

  log.info({ configPath: runtimePaths.configPath, configLoaded, dataDir: config.database.path, logsDir: config.logs.dir }, "Configuration loaded");

  const staticAssetService = await StaticAssetService.create(runtimePaths.staticRoot);
  if (staticAssetService.isAvailable()) {
    log.info({ staticRoot: runtimePaths.staticRoot }, "Static assets loaded");
  } else {
    log.warn({ staticRoot: runtimePaths.staticRoot }, "Static assets not found, running in API-only mode");
  }
  if (cliOverrides.healthCheck) {
    log.info({ staticRoot: runtimePaths.staticRoot }, "Health check passed");
    process.exit(0);
  }

  store.configure(config.database.path);

  const objectStore = new ObjectStore();
  const checksumService = new ChecksumService();
  const artifactService = new ArtifactService(objectStore, checksumService);
  const solutionService = new SolutionService(objectStore, artifactService);

  const sseManager = new SseManager();
  const resolverRegistry = new ResolverRegistry();

  type TaskRegEntry = {
    name: string;
    real: TaskResolverClass;
    mock?: TaskResolverClass;
  };

  function registerTasks(
    registry: ResolverRegistry,
    mockMode: boolean,
    entries: TaskRegEntry[]
  ): void {
    for (const entry of entries) {
      const cls = mockMode && entry.mock ? entry.mock : entry.real;
      registry.register(entry.name, cls);
    }
  }

  registerTasks(resolverRegistry, config.runtime.mock, [
    { name: "SshCommandTask", real: SshCommandTask, mock: MockSshCommandTask },
    { name: "GetRobotBasicInfoTask", real: GetRobotBasicInfoTask, mock: MockGetRobotBasicInfoTask },
    { name: "GetRobotSoftwareInfoTask", real: GetRobotSoftwareInfoTask, mock: MockGetRobotSoftwareInfoTask },
    { name: "UpdateRobotBasicInfoTask", real: UpdateRobotBasicInfoTask, mock: MockUpdateRobotBasicInfoTask },
    { name: "UpdateRobotSoftwareInfoTask", real: UpdateRobotSoftwareInfoTask, mock: MockUpdateRobotSoftwareInfoTask },
    { name: "SshFileTransferTask", real: SshFileTransferTask, mock: MockSshFileTransferTask },
    { name: "UpgradeMovebaseTask", real: UpgradeMovebaseTask, mock: MockUpgradeMovebaseTask },
    { name: "TransferMovebaseTask", real: TransferMovebaseTask, mock: MockTransferMovebaseTask },
    { name: "DeleteMovebaseTask", real: DeleteMovebaseTask, mock: MockDeleteMovebaseTask },
    { name: "RebootRobotTask", real: RebootRobotTask, mock: MockRebootRobotTask },
    { name: "MatchFileContentTask", real: MatchFileContentTask, mock: MockMatchFileContentTask },
    { name: "MatchMovebaseVersionTask", real: MatchMovebaseVersionTask, mock: MockMatchMovebaseVersionTask },
    { name: "TransferBUPTask", real: TransferBUPTask, mock: MockTransferBUPTask },
    { name: "TransferBUPScriptTask", real: TransferBUPScriptTask, mock: MockTransferBUPScriptTask },
    { name: "UpgradeBUPTask", real: UpgradeBUPTask, mock: MockUpgradeBUPTask },
    { name: "MatchBUPVersionTask", real: MatchBUPVersionTask, mock: MockMatchBUPVersionTask },
    { name: "DeleteBUPTask", real: DeleteBUPTask, mock: MockDeleteBUPTask },
    { name: "MovebaseDiskCleanupTask", real: MovebaseDiskCleanupTask, mock: MockMovebaseDiskCleanupTask },
    { name: "TransferAlpha2MapTask", real: TransferAlpha2MapTask, mock: MockTransferAlpha2MapTask },
    { name: "ApplyAlpha2MapTask", real: ApplyAlpha2MapTask, mock: MockApplyAlpha2MapTask },
    { name: "DeleteAlpha2MapTask", real: DeleteAlpha2MapTask, mock: MockDeleteAlpha2MapTask },
    { name: "SleepTask", real: SleepTask, mock: MockSleepTask },
    { name: "WaitSshConnectedTask", real: WaitSshConnectedTask, mock: MockWaitSshConnectedTask },
    { name: "WaitSshDisconnectedTask", real: WaitSshDisconnectedTask, mock: MockWaitSshDisconnectedTask },
    { name: "WaitSshReconnectTask", real: WaitSshReconnectTask, mock: MockWaitSshReconnectTask },
    { name: "TransferIotGatewayConfigTask", real: TransferIotGatewayConfigTask, mock: MockTransferIotGatewayConfigTask },
    { name: "UpdateIotGatewayConfigTask", real: UpdateIotGatewayConfigTask, mock: MockUpdateIotGatewayConfigTask },
    { name: "SshFileDownloadTask", real: SshFileDownloadTask, mock: MockSshFileDownloadTask },
    { name: "TransferAEConfigTask", real: TransferAEConfigTask, mock: MockTransferAEConfigTask },
    { name: "DeployAEConfigTask", real: DeployAEConfigTask, mock: MockDeployAEConfigTask },
    { name: "DeleteAEConfigTask", real: DeleteAEConfigTask, mock: MockDeleteAEConfigTask },
    { name: "TransferAppTask", real: TransferAppTask, mock: MockTransferAppTask },
    { name: "InstallAppTask", real: InstallAppTask, mock: MockInstallAppTask },
    { name: "CleanupAppTask", real: CleanupAppTask, mock: MockCleanupAppTask },
  ]);

  const taskFlowEngine = new TaskFlowEngine(objectStore, sseManager, resolverRegistry);

  const memStoreInstance = new MemStore();

  const robotService = new RobotService(objectStore, taskFlowEngine, sseManager, memStoreInstance, {
    sshUsername: SSH_USERNAME,
    sshPassword: SSH_PASSWORD,
  });

  taskFlowEngine.setFlowContext({ memStore: memStoreInstance, artifactService });

  solutionService.onSolutionRemove((solutionId: string) => {
    robotService.removeSolutionCache(solutionId);
  });
  solutionService.onSolutionClose((solutionId: string) => {
    robotService.removeSolutionCache(solutionId);
  });

  const app = new Hono();

  app.use("*", cors());

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = c.req.path;
    log.info({ method, path, status, durationMs: duration }, "HTTP request");
  });

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.post("/api/shutdown", async (c) => {
    log.info("Shutdown requested via API");
    c.json({ message: "Server shutting down..." });
    setTimeout(() => process.exit(0), 300);
    return c.body(null);
  });

  const systemLogService = new SystemLogService({
    logsDir: config.logs.dir,
    studioVersion: "1.0.0",
  });

  app.route("/api/system-logs", createSystemLogRoutes(systemLogService));

  app.route("/api/objects", createObjectStoreRoutes(objectStore, config.database.path));
  app.route("/api/artifacts", createArtifactRoutes(artifactService));
  app.route("/api/solutions", createSolutionRoutes(solutionService));
  app.route("/api/solutions/:solutionId/robots", createRobotRoutes(robotService));
  app.route("/api/memstore", createMemStoreRoutes(memStoreInstance));
  app.route("/api/sse", createSseRoutes(sseManager));

  await taskFlowEngine.loadPersistedFlows();

  app.route("/api/flows", createTaskFlowRoutes(taskFlowEngine));
  app.route("/", createStaticRoutes(staticAssetService));

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "NOT_FOUND", message: "API route not found." }, 404);
    }
    return c.text("Not found", 404);
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      log.warn({ code: err.code, message: err.message, statusCode: err.statusCode }, "Application error");
      return c.json({ error: err.code, message: err.message }, err.statusCode);
    }
    log.error({ err: err.message }, "Unhandled error");
    return c.json({ error: "INTERNAL_ERROR", message: "An unexpected error occurred." }, 500);
  });

  if (config.runtime.mock) {
    log.info("Mock mode enabled");
  }
  if (config.server.host === "0.0.0.0") {
    log.warn({ host: config.server.host }, "Server exposed on all interfaces");
  }

  try {
    const server = serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port });
    server.on("listening", () => {
      const displayHost = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
      const url = `http://${displayHost}:${config.server.port}`;
      log.info({ host: config.server.host, port: config.server.port, url }, "RobotOps Studio started");
      process.stdout.write(`\n  RobotOps Studio is running at ${url}\n`);
      process.stdout.write(`  Press Ctrl+C or send POST ${url}/api/shutdown to stop\n\n`);
      if (isPkgRuntime()) {
        openBrowser(url);
      }
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.error({ host: config.server.host, port: config.server.port, code: err.code }, "Port already in use");
        process.exit(1);
      }
      log.error({ err: err.message, code: err.code }, "Server start failed");
      process.exit(1);
    });
  } catch (err) {
    startupLog.error({ err: err instanceof Error ? err.message : String(err) }, "Startup failed");
    process.exit(1);
  }
}

main().catch(err => {
  startupLog.error({ err: err instanceof Error ? err.message : String(err) }, "Startup failed");
  process.exit(1);
});
