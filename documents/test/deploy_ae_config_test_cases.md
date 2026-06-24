# 配置下位机 AE 文件 — 测试用例设计文档

> 关联需求：`documents/requirements/deploy_ae_config_requirements.md`
> 关联设计：`documents/design/deploy_ae_config_design.md`

---

## 1. 测试策略

### 1.1 测试范围

- **单元/集成测试**（`src/backend/src/test.ts`，扩展即可）：覆盖三类新增任务的命令拼装、参数继承、artifact 路径解析与传输联动、清理幂等性。
- **E2E 测试**（`src/e2e-test/tests/task-management.spec.ts`）：覆盖前端 CreateTaskModal 中 `Deploy AE Config` 任务类型的可见性、参数渲染与多机器人选择。
- **mock 模式 E2E**：使用 `MockTransferAEConfigTask` / `MockDeployAEConfigTask` / `MockDeleteAEConfigTask`，无需真实机器人。

### 1.2 测试框架

- 后端：`node:test` + `node:assert`，已有入口 `src/backend/src/test.ts`。
- E2E：Playwright，已有 `playwright.config.ts` 启动 mock 后端 + Vite 前端。

### 1.3 测试用例 ID 命名

- 后端：`TC-AE-NNN`
- E2E：`TC-E2E-AE-NNN`

---

## 2. 后端用例

### TC-AE-001：DeployAEConfigTask 命令拼装（启用 sudo）

| 项 | 值 |
|----|-----|
| 优先级 | 高 |
| 前置条件 | 实例化 `DeployAEConfigTask`，参数仅含 `robotIp`、`robotPort` |
| 输入 | 调用 `getSshCommand({})` 与 `buildParams({ robotIp, robotPort })` |
| 预期 | `sshCommand` 包含按顺序出现的关键片段：`[ -d /opt/cosmos/bin/applet-engine ] || { echo "Deploy target not found: /opt/cosmos/bin/applet-engine" >&2; exit 1; }`、`unzip -o /tmp/ae_config_package.zip -d /opt/cosmos/bin/applet-engine`、`chown -R cosmos:cosmos /opt/cosmos/bin/applet-engine`、`systemctl restart cosmos-applet-engine.service`、`rm -f /tmp/ae_config_package.zip`；命令字符串中**不**包含 `mkdir -p /opt/cosmos/bin/applet-engine`（不自动创建部署目录），**也不**包含 `/tmp/ae_config_extract`（不再使用中转解压目录），**也不**包含 `/home/developer`（暂存路径必须位于 `/tmp/`），**也不**包含 `reboot`（不重启整机）；`buildParams` 返回的 `sudo === true`，`commandTimeout === 60000`，`retryCount === 1`。 |

### TC-AE-002：DeleteAEConfigTask 命令拼装

| 项 | 值 |
|----|-----|
| 优先级 | 高 |
| 前置条件 | 实例化 `DeleteAEConfigTask` |
| 输入 | `getSshCommand({})` |
| 预期 | 返回 `rm -f /tmp/ae_config_package.zip`；`buildParams` 返回的 `sudo === true`。 |

### TC-AE-003：TransferAEConfigTask 远程路径覆盖

| 项 | 值 |
|----|-----|
| 优先级 | 高 |
| 前置条件 | 实例化 `TransferAEConfigTask` |
| 输入 | `buildParams({ robotIp, robotPort, localFilePath: "/tmp/x.zip" })` |
| 预期 | 返回的 `remoteFilePath === "/tmp/ae_config_package.zip"`，`sudo === true`。 |

### TC-AE-004：TransferAEConfigTask 通过 artifactService.getArtifactPath 解析本地路径并传输

| 项 | 值 |
|----|-----|
| 优先级 | 高 |
| 前置条件 | 注入 mock `artifactService`，其中 `getArtifactPath(artifactId)` 直接返回一个本地虚拟路径；mock 父类 `super.onExec` 仅断言 `params.localFilePath` 等于 `getArtifactPath` 的返回值。 |
| 输入 | `onExec({ artifactId: "art-1" }, { artifactService })` |
| 预期 | `artifactService.getArtifactPath` 被调用一次（参数为传入的 `artifactId`）；`super.onExec` 收到的 `params.localFilePath` 等于 `getArtifactPath` 的返回值；不创建/清理任何临时目录。 |

### TC-AE-005：TransferAEConfigTask 缺失 artifactId 时直通父类

| 项 | 值 |
|----|-----|
| 优先级 | 中 |
| 前置条件 | 不传 `artifactId`，提供 `localFilePath` 现有文件 |
| 输入 | `onExec({ localFilePath })` |
| 预期 | 不调用 `artifactService.getArtifactPath`；行为与父类 `SshFileTransferTask` 一致。 |

### TC-AE-006：mock 任务返回成功

| 项 | 值 |
|----|-----|
| 优先级 | 中 |
| 前置条件 | 实例化 `MockTransferAEConfigTask`、`MockDeployAEConfigTask`、`MockDeleteAEConfigTask` |
| 输入 | 各自调用 `onExec({})` |
| 预期 | 三者均在合理时间内（≤6s）resolve，返回 `{ done: true, success: true, ... }`。 |

### TC-AE-007：tasks/index.ts 导出三个新增任务

| 项 | 值 |
|----|-----|
| 优先级 | 中 |
| 前置条件 | `import { TransferAEConfigTask, DeployAEConfigTask, DeleteAEConfigTask, MockTransferAEConfigTask, MockDeployAEConfigTask, MockDeleteAEConfigTask } from "./tasks/index.js"` |
| 输入 | 直接读取 import 后的引用 |
| 预期 | 全部为构造函数（`typeof === "function"`）。 |

---

## 3. 前端 / E2E 用例

### TC-E2E-AE-001：Deploy AE Config 任务类型可见

| 项 | 值 |
|----|-----|
| 优先级 | 高 |
| 前置条件 | 解决方案中至少有 1 台机器人；进入「Tasks → Create」 |
| 步骤 | 打开 CreateTaskModal，留在 Type 步骤 |
| 预期 | 看到任务卡片 `Deploy AE Config`，描述包含 `applet-engine`；卡片显示 `Robot selection: Multiple robots`。 |

### TC-E2E-AE-002：Deploy AE Config 走到 Robots 步骤

| 项 | 值 |
|----|-----|
| 优先级 | 高 |
| 前置条件 | 同 TC-E2E-AE-001 |
| 步骤 | 选中 `Deploy AE Config` 卡片 → Next |
| 预期 | 进入 Robots 步骤，可见 `Select all robots` 复选框与机器人列表。 |

### TC-E2E-AE-003：Deploy AE Config 参数步骤渲染制品选择器

| 项 | 值 |
|----|-----|
| 优先级 | 高 |
| 前置条件 | 解决方案中至少 1 台机器人 + 至少 1 个制品 |
| 步骤 | 选 `Deploy AE Config` → Robots 选 1 台 → Next |
| 预期 | Params 步骤显示 `AE config package` 字段，且为制品选择器（与 Upgrade Movebase 等 artifact 字段呈现一致）。 |

### TC-E2E-AE-004：现有任务类型计数同步更新

| 项 | 值 |
|----|-----|
| 优先级 | 中 |
| 前置条件 | 同 TC-E2E-AE-001 |
| 步骤 | 打开 CreateTaskModal，留在 Type 步骤 |
| 预期 | `Robot selection: Multiple robots` 文本计数从 4 增加到 5；先前的四个任务类型（Upgrade BUP / Movebase Disk Cleanup / Upgrade Movebase / Apply Alpha2 Map）仍可见。 |

---

## 4. 验收映射

| 验收项（需求） | 覆盖用例 |
|----------------|----------|
| AC-AE-001 | TC-E2E-AE-001、TC-E2E-AE-002、TC-E2E-AE-004 |
| AC-AE-002 | TC-AE-001、TC-AE-003、TC-AE-004 |
| AC-AE-003 | TC-AE-001（chown 部分）+ 真机验收 |
| AC-AE-004 | TC-AE-001（rm -f 与 systemctl restart 段）+ TC-AE-002 |
| AC-AE-005 | TC-AE-002 + 真机验收（errorDag 触发） |
| AC-AE-006 | TC-AE-006、TC-E2E-AE-001~004 |
| AC-AE-007 | TC-AE-001（断言含 `Deploy target not found` 失败检查段）|
