# Backend Task Resolver Technical Design

> **Update**: All task resolver classes now derive from `BaseTask` (directly or via secondary base classes such as `SshCommandTask` / `SshFileTransferTask`). `BaseTask` implements `ITaskResolver` from `flowed`, orchestrates the `onInitialize → onExec → onDestroy` lifecycle, owns `ignoreFailure` translation, and injects structured logging fields (`flowId`, `name`, `taskCode`, `flowPhase`). See:
> - Requirements: `documents/requirements/backend_base_task_requirements.md`
> - Design: `documents/design/backend_base_task_design.md`
> - Test cases: `documents/test/backend_base_task_test_cases.md`
>
> Per-task sections below describe each task's input / output / notes. The `ignoreFailure` parameter is owned by `BaseTask` for tasks whose failure is expressed by **throwing** (e.g. `SshCommandTask`, `SshFileTransferTask` and their derivatives); on such a thrown failure with `ignoreFailure: true`, BaseTask returns the standardized body `{ done: true, success: false, ignored: true, error }` rather than partial results. Tasks with an explicit internal **soft-failure return path** (e.g. `WaitSshConnectedTask` / `WaitSshReconnectTask`) keep their existing partial-result fields (`state`, `attempts`, `elapsedMs`, etc.) — see the per-task notes and `backend_base_task_design.md` §2.2.

All task resolver classes derive from `BaseTask`, which implements `ITaskResolver` from `flowed`:
```
exec(params: ValueMap, context?: ValueMap): Promise<ValueMap>
```
`ValueMap` is effectively `Record<string, unknown>`.

Shared SSH credentials (from `../../config.js`):
- `SSH_USERNAME = "developer"`
- `SSH_PASSWORD = "developer"`

---

## 1. SshCommandTask

Base class for all SSH command execution tasks.

### Overview

Executes a shell command on a remote robot via raw SSH (ssh2 library). Supports IP and mDNS host resolution, automatic sudo wrapping, retry with exponential backoff, and separate connection/command timeouts.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `robotIp` | `string` | (required) | Target robot IP address |
| `robotPort` | `number` | `22` | SSH port |
| `robotMdnsDomain` | `string \| undefined` | `undefined` | mDNS domain, takes precedence over IP |
| `timeout` | `number` | `10000` | General timeout (ms), fallback for connectTimeout/commandTimeout |
| `connectTimeout` | `number` | `10000` | SSH connection timeout (ms) |
| `commandTimeout` | `number` | `30000` | Command execution timeout (ms) |
| `retryCount` | `number` | `3` | Max retry attempts on failure |
| `sshUsername` | `string` | `SSH_USERNAME` | SSH login username |
| `sshPassword` | `string` | `SSH_PASSWORD` | SSH login password |
| `sshCommand` | `string` | (subclass-defined) | Shell command to execute |
| `sudo` | `boolean` | `false` | Whether to wrap command with sudo |
| `ignoreFailure` | `boolean` | `false` | Handled by `BaseTask`; see `backend_base_task_design.md` for the standardized failure result body |

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `done` | `true` | Flow completion marker |
| `success` | `true` | Task success marker |
| `stdout` | `string` | Command standard output |
| `stderr` | `string` | Command standard error |
| `exitCode` | `number \| null` | Command exit code |

### Notes

- Host resolution: uses `robotMdnsDomain` if present, otherwise `robotIp`
- Sudo wrapping: prepends `echo "<password>" | sudo -S -p ''` to each `&&`-separated segment
- Retry uses exponential backoff: `sleep(1000 * attempt)` between attempts
- Throws if exit code != 0 after all retries; `ignoreFailure` is no longer handled here.
- On failure, `BaseTask` performs the `ignoreFailure` translation: when `ignoreFailure: true`, the standardized body `{ done: true, success: false, ignored: true, error }` is returned (no `stdout` / `stderr` / `exitCode`); when `ignoreFailure: false` or omitted, the original error is rethrown. See `backend_base_task_design.md` §2.2 for the migration-time output change.
- Subclass overrides: `getSshCommand()` defines the command, `buildParams()` customizes defaults

---

## 2. SshFileTransferTask

Base class for all SFTP file transfer tasks.

### Overview

Uploads a local file to a remote robot via SFTP (ssh2 library). Validates local file existence, optionally verifies integrity via checksum comparison (local vs remote), creates remote parent directories, and supports progress logging.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `robotIp` | `string` | (required) | Target robot IP address |
| `robotPort` | `number` | `22` | SSH port |
| `robotMdnsDomain` | `string \| undefined` | `undefined` | mDNS domain |
| `timeout` | `number` | `30000` | General timeout (ms) |
| `retryCount` | `number` | `3` | Max retry attempts |
| `sshUsername` | `string` | `SSH_USERNAME` | SSH login username |
| `sshPassword` | `string` | `SSH_PASSWORD` | SSH login password |
| `localFilePath` | `string` | (required) | Local file path to upload |
| `remoteFilePath` | `string` | (required) | Remote destination path |
| `sudo` | `boolean` | `false` | Whether to use sudo for mkdir |
| `verifyChecksum` | `boolean` | `true` | Whether to verify transfer integrity |
| `checksumAlgorithm` | `"sha256" \| "md5"` | `"sha256"` | Checksum algorithm |

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `done` | `true` | Flow completion marker |
| `success` | `true` | Task success marker |
| `bytesTransferred` | `number` | Total bytes transferred |
| `localChecksum` | `string` | Local file checksum |
| `remoteChecksum` | `string` | Remote file checksum |
| `integrityVerified` | `boolean` | Whether checksums matched |

### Notes

- Validates local file exists via `stat()` before connecting
- Creates remote parent directories via `mkdir -p` (with sudo wrapping if enabled)
- Transfers via SFTP `fastPut` with progress logging every 2 seconds
- Remote checksum computed by running `sha256sum` or `md5sum` on the robot via SSH

---

## 3. GetRobotBasicInfoTask

### Overview

Reads robot hardware information from `/sys/robotInfo/*` and `/opt/cosmos/etc/secure/iot-gateway/device_id` via a shell script, parses the JSON output, and returns a structured `RobotBasicInfo` object.

### Input Parameters

Inherits all from `SshCommandTask`.

No additional parameters (command is hardcoded).

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `success` | `true` | Task success marker |
| `rawOutput` | `string` | Full stdout from the shell script |
| `robotInfo` | `RobotBasicInfo` | Parsed robot info object |
| `robotInfo.model` | `string` | Robot model |
| `robotInfo.robotSn` | `string` | Robot serial number |
| `robotInfo.thingsId` | `string` | IoT device ID |
| `robotInfo.vendorId` | `string` | Vendor ID |
| `robotInfo.productId` | `string` | Product ID |
| `robotInfo.mainBoardSn` | `string` | Main board serial number |
| `robotInfo.mainBoardId` | `string` | Main board ID |
| `robotInfo.mainSomSn` | `string` | SOM serial number |

### Notes

- Executes a multi-command shell script that reads from `cat`, `grep`, and `awk`
- Expects a JSON line in stdout; parses the first JSON line found
- Reads from `/sys/robotInfo/`, `/opt/cosmos/etc/secure/`, and `/sys/firmware/devicetree/base/`

---

## 4. UpdateRobotBasicInfoTask

### Overview

Writes robot basic info into the in-memory LRU cache (`MemStore`). No SSH or network operations.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cacheKey` | `string` | (required) | Cache key for the robot |
| `robotInfo` | `RobotBasicInfo` | (required) | Robot info object to cache |

### Context Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `memStore` | `MemStore` | In-memory cache instance |

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `success` | `true` | Task success marker |
| `updated` | `true` | Confirmation of cache update |

### Notes

- Only performs update if `cacheKey`, `robotInfo`, and `memStore` are all present
- Calls `memStore.updateCache(cacheKey, robotInfo)`
- Basic info and software info are stored in separate cache entries (`{key}` and `{key}/sw`)

---

## 5. GetRobotSoftwareInfoTask

### Overview

Reads robot software version information from `/opt/cosmos/etc/ota/version`, `/mnt/cosmos/boot/etc/ota/minimal_system_version`, and `/etc/l4t_jurassic_release` via a shell script, parses the JSON output, and returns a structured `RobotSoftwareInfo` object.

### Input Parameters

Inherits all from `SshCommandTask`.

No additional parameters (command is hardcoded).

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `success` | `true` | Task success marker |
| `rawOutput` | `string` | Full stdout from the shell script |
| `softwareInfo` | `RobotSoftwareInfo` | Parsed software info object |
| `softwareInfo.movebaseVersion` | `string` | Movebase version from `/opt/cosmos/etc/ota/version` |
| `softwareInfo.minimalSystemVersion` | `string` | Minimal system version from `/mnt/cosmos/boot/etc/ota/minimal_system_version` |
| `softwareInfo.l4tVersion` | `string` | L4T release version from `/etc/l4t_jurassic_release` |

### Notes

- Executes a multi-command shell script that reads from `cat` on three separate files
- The robotService DAG chains this task after `GetRobotBasicInfoTask` (requires `robotInfo` for sequential execution)
- Expects a JSON line in stdout; parses the first JSON line found

---

## 6. UpdateRobotSoftwareInfoTask

### Overview

Writes robot software version info into a separate in-memory LRU cache entry (`MemStore`). No SSH or network operations.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cacheKey` | `string` | (required) | Cache key for the robot software info (`{baseKey}/sw`) |
| `softwareInfo` | `RobotSoftwareInfo` | (required) | Robot software info object to cache |

### Context Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `memStore` | `MemStore` | In-memory cache instance |

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `success` | `true` | Task success marker |
| `updated` | `true` | Confirmation of cache update |

### Notes

- Software info is stored in a separate cache entry from basic info (key suffixed with `/sw`)
- Only performs update if `cacheKey`, `softwareInfo`, and `memStore` are all present

---

## 7. DeleteRemotePathTask

### Overview

Deletes a specified path on the remote robot via `rm -rf` with sudo.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `targetPath` | `string` | (required) | Remote path to delete |

Inherits all from `SshCommandTask`. `sudo` is forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Refuses to delete root path `"/"` — throws an error
- Double-quote escapes the target path in the generated command
- Command format: `rm -rf -- "<escapedPath>"`

---

## 8. DeleteMovebaseTask

### Overview

Deletes the movebase offline OTA directory (`/mnt/sdcard/offlineota`) on the remote robot.

### Input Parameters

Inherits all from `SshCommandTask`. No additional parameters. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded command: `rm -rf /mnt/sdcard/offlineota`
- Used as the cleanup step in both movebase and BUP upgrade flows

---

## 9. TransferMovebaseTask

### Overview

Resolves the artifact storage path from the artifact service and uploads the artifact file to the robot via SFTP. No intermediate temp directory is used.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `artifactId` | `string` | (optional) | Artifact ID to resolve and transfer |

Inherits all from `SshFileTransferTask`. `sudo` forced to `true`, `remoteFilePath` hardcoded.

### Context Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `artifactService` | `{ getArtifactPath(id): Promise<string> }` | Service to resolve artifact storage path |

### Output Parameters

Same as `SshFileTransferTask`.

### Notes

- Hardcoded remote path: `/mnt/sdcard/offlineota/alpha2_movebase_offline_package.zip`
- Uses `artifactService.getArtifactPath(artifactId)` to resolve the local file path directly
- If `artifactId` or `artifactService` is absent, falls through to `super.onExec()` directly

---

## 10. UpgradeMovebaseTask

### Overview

Executes the movebase offline upgrade script on the remote robot.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `commandTimeout` | `number` | `900000` (15 min) | Override for long-running install |

Inherits all from `SshCommandTask`. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded 3-step command: (1) remove old extracted package, (2) unzip new package, (3) run `install_offline.sh`
- Default 15-minute timeout accommodates slow install scripts

---

## 11. RebootRobotTask

### Overview

Reboots the remote robot via `sudo reboot`. Tolerates expected connection-loss errors that occur when the robot goes down.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `bootWaitMs` | `number` | `0` | Wait duration before sending reboot command (ms), used to wait for async upgrade completion |

Inherits all from `SshCommandTask`. `sudo` forced to `true`, `retryCount` forced to `1`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded command: `reboot`
- Catches connection-loss errors (`timed out`, `connection lost`, `socket`, `econnreset`, `not connected`, `connection ended`) and treats them as success
- If `bootWaitMs > 0`, sleeps that duration before sending reboot command, allowing async upgrade scripts to complete on the robot
- BUP upgrade flow configures `bootWaitMs: 60000` (60s) in the DAG

---

## 12. MatchFileContentTask

### Overview

Reads a remote file via `cat` and compares its content (trimmed) against an expected string.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filePath` | `string` | (required) | Full path to the remote file |
| `expectedContent` | `string` | (required) | Expected file content (exact match after trim) |

Inherits all from `SshCommandTask`. `sudo` forced to `false`, `retryCount` forced to `1`.

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| (inherited) | | All fields from `SshCommandTask` |
| `matched` | `true` | Content match confirmed |
| `filePath` | `string` | Path that was checked |
| `expectedContent` | `string` | Expected content |
| `actualContent` | `string` | Actual file content (trimmed) |

### Notes

- Generates SSH command: `cat "<filePath>"`
- Comparison is exact-match after trimming whitespace from both sides
- Throws with a detailed mismatch error if content differs

---

## 13. MatchMovebaseVersionTask

### Overview

Checks the robot's movebase version file against an expected version string. Used for post-upgrade verification.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `retryCount` | `number` | `10` | High retry count for post-reboot timing |
| `commandTimeout` | `number` | `30000` | Command timeout (ms) |
| `connectTimeout` | `number` | `10000` | Connection timeout (ms) |

Inherits `filePath` and `expectedContent` from `MatchFileContentTask`.

### Output Parameters

Same as `MatchFileContentTask`.

### Notes

- Hardcoded file path: `/opt/cosmos/etc/ota/version`
- Default 10 retries account for post-reboot boot-up time
- Inherits content comparison logic from `MatchFileContentTask`

---

## 14. TransferBUPTask

### Overview

Resolves the BUP artifact storage path from the artifact service and uploads the artifact file to the robot via SFTP. No intermediate temp directory is used.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `artifactId` | `string` | (optional) | Artifact ID to resolve and transfer |

Inherits all from `SshFileTransferTask`. `sudo` forced to `true`, `remoteFilePath` hardcoded.

### Context Parameters

Same as `TransferMovebaseTask` (`artifactService`).

### Output Parameters

Same as `SshFileTransferTask`.

### Notes

- Hardcoded remote path: `/mnt/sdcard/bup_offlineota/bup_offline_package.zip`
- Uses `artifactService.getArtifactPath(artifactId)` to resolve the local file path directly
- Implementation mirrors `TransferMovebaseTask`

---

## 15. TransferBUPScriptTask

### Overview

Transfers the `upgrade_bup.sh` script from the backend `res/` directory to `/tmp/upgrade_bup.sh` on the remote robot via SFTP. Executed after the BUP artifact transfer, before the upgrade command.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| (none task-specific) | | | |

Inherits all from `SshFileTransferTask`. `localFilePath`, `remoteFilePath`, `sudo`, `verifyChecksum`, and `retryCount` are hardcoded.

### Output Parameters

Same as `SshFileTransferTask`.

### Notes

- Hardcoded local path: resolved to `res/upgrade_bup.sh` relative to the backend source root
- Hardcoded remote path: `/tmp/upgrade_bup.sh`
- `sudo` forced to `true`, `verifyChecksum` forced to `false`, `retryCount` forced to `1`
- The remote script is consumed by `UpgradeBUPTask` which runs it in the upgrade command chain

---

## 16. UpgradeBUPTask

### Overview

Executes the BUP firmware upgrade on the remote robot.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `commandTimeout` | `number` | `900000` (15 min) | Override for long-running upgrade |

Inherits all from `SshCommandTask`. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded command: (1) remove old extracted BUP package, (2) unzip new BUP package to `/mnt/sdcard/bup_offlineota`, (3) sync `/etc/l4t_jurassic_release` and `/etc/jurassic_release` (copy whichever file is missing from the existing one), (4) chmod both the package scripts and `/tmp/upgrade_bup.sh`, (5) run `/tmp/upgrade_bup.sh` (transferred by `TransferBUPScriptTask`)
- Default 15-minute timeout accommodates slow upgrade scripts
- Structure mirrors `UpgradeMovebaseTask`
- BUP working directory: `/mnt/sdcard/bup_offlineota`

---

## 17. MatchBUPVersionTask

### Overview

Checks the robot's BUP version file against an expected version string. Used for post-upgrade verification. The comparison uses suffix matching because robot BUP release strings may include a prefix while the frontend supplies only the version suffix.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `retryCount` | `number` | `10` | High retry count for post-reboot timing |
| `commandTimeout` | `number` | `30000` | Command timeout (ms) |
| `connectTimeout` | `number` | `10000` | Connection timeout (ms) |

Inherits `filePath` and `expectedContent` from `MatchFileContentTask`.

### Output Parameters

Same as `MatchFileContentTask`.

### Notes

- Hardcoded file path: `/etc/l4t_jurassic_release`
- Matches `actualContent.trim().endsWith(expectedContent.trim())`; for example, actual `xxx-1.1.945` matches expected `1.1.945`
- Keeps retry and timeout behavior aligned with post-reboot BUP verification

---

## 18. DeleteBUPTask

### Overview

Deletes the BUP offline OTA directory (`/mnt/sdcard/offlineota`) on the remote robot.

### Input Parameters

Inherits all from `SshCommandTask`. No additional parameters. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded command: `rm -rf /mnt/sdcard/offlineota`
- Used as the cleanup step in the BUP upgrade flow

---

## 19. TransferAEConfigTask

### Overview

Resolves the AE config artifact storage path from the artifact service, then uploads it to the robot via SFTP. Used as the first step of the `Deploy AE Config` flow.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `artifactId` | `string` | (optional) | Artifact ID to download |

Inherits all from `SshFileTransferTask`. `sudo` forced to `true`, `remoteFilePath` hardcoded.

### Context Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `artifactService` | `{ getArtifactPath(id): Promise<string> }` | Service to resolve artifact storage path |

### Output Parameters

Same as `SshFileTransferTask`.

### Notes

- Hardcoded remote path: `/tmp/ae_config_package.zip`
- Resolves local path via `artifactService.getArtifactPath(artifactId)` (no temp directory created); falls through to parent `SshFileTransferTask.onExec` when no `artifactId`/`artifactService` is provided.
- If `artifactId` or `artifactService` is absent, falls through to `super.exec()` directly

---

## 20. DeployAEConfigTask

### Overview

Extracts the uploaded AE config zip directly into `/opt/cosmos/bin/applet-engine` on the robot, fixes ownership to `cosmos:cosmos`, removes the original zip on `/tmp`, and restarts `cosmos-applet-engine.service`.

### Input Parameters

Inherits all from `SshCommandTask`. `sudo` forced to `true`, `commandTimeout` defaults to `60000`, and `retryCount` is forced to `1` because the deploy command mutates remote state and must not be retried without rerunning transfer.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded multi-step command: verify `/opt/cosmos/bin/applet-engine` exists (fail with non-zero exit when missing), `unzip -o` the package directly into the deploy directory, `chown -R cosmos:cosmos`, remove the zip on `/tmp`, then run `systemctl restart cosmos-applet-engine.service`.
- Does **not** auto-create the deploy target directory. If `/opt/cosmos/bin/applet-engine` is missing, the first segment exits with code 1 and stderr `Deploy target not found: /opt/cosmos/bin/applet-engine`, causing the whole chain to fail.
- `unzip -o` overwrites same-named files inside the deploy directory without prompting and does NOT clear pre-existing files outside the zip's content set. No `/tmp/ae_config_extract` staging directory is used.
- Used as the `deploy` step of the Deploy AE Config DAG.

---

## 21. DeleteAEConfigTask

### Overview

Removes the transferred AE config zip on the robot at `/tmp/ae_config_package.zip`. Idempotent and safe to invoke from the Deploy AE Config errorDag.

### Input Parameters

Inherits all from `SshCommandTask`. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded command: `rm -f /tmp/ae_config_package.zip`
- Implementation mirrors `DeleteMovebaseTask`

---

## 19. MovebaseDiskCleanupTask

### Overview

Runs the Alpha2 Movebase post-upgrade disk cleanup SOP on a remote robot through SSH. The task removes known upgrade residue with a compact `&&`-chained cleanup command.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cleanUserHomes` | `boolean \| string` | `false` | When true, also cleans contents of `/home/developer` and `/home/factory`. Kept false by default because those locations can contain user-generated FAE or factory files. |
| `commandTimeout` | `number` | `10000` | Command execution timeout (ms) |
| `retryCount` | `number` | `1` | Max retry attempts |

Inherits all connection and credential parameters from `SshCommandTask`. `sudo` is forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Deletes `/etc/l4t_ota` when present.
- Deletes only `.deb` and `.apk` files under `/opt/cosmos/ota/recovery`.
- Deletes `/opt/cosmos/lib/vendor` when present.
- Cleans contents of `/mnt/cosmos/boot/lib/bootstrapper` when present.
- Cleans `/home/developer` and `/home/factory` contents only when `cleanUserHomes` is true.
- Does not automatically delete files under `/opt/cosmos/bin` to avoid removing executable programs.
- Uses a direct cleanup command chain joined by `&&`; it does not emit extra `echo`, `df -h`, or `du -sh` output.
- Missing optional directories are tolerated through `find ... 2>/dev/null || true` where needed.
- Mock variant returns a successful SSH-style result without connecting to a robot.

---

## 20. SleepTask

### Overview

Pauses the task flow for a configurable number of milliseconds. Used to wait between dependent tasks (e.g., waiting for robot reboot to complete).

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sleepMs` | `number` | `0` | Duration to sleep in milliseconds |

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `done` | `true` | Flow completion marker |
| `success` | `true` | Task success marker |

### Notes

- Does not require SSH connection or robot interaction
- Simply awaits `setTimeout` for the specified duration in milliseconds
- Mock variant returns immediately without sleeping
- BUP upgrade flow configures `sleepMs: 120000` (120s) in the DAG

---

## 21. WaitSshConnectedTask

### Overview

Waits until an SSH session can be established with the robot. The task only verifies connection readiness and closes the SSH session immediately after `ready`; it does not execute a remote command.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `robotIp` | `string` | (required) | Target robot IP address |
| `robotPort` | `number` | `22` | SSH port |
| `robotMdnsDomain` | `string \| undefined` | `undefined` | mDNS domain, takes precedence over IP |
| `sshUsername` | `string` | `SSH_USERNAME` | SSH login username |
| `sshPassword` | `string` | `SSH_PASSWORD` | SSH login password |
| `timeout` | `number \| undefined` | `undefined` | Total wait timeout in milliseconds; undefined means wait indefinitely |
| `ignoreFailure` | `boolean` | `false` | If true, on timeout this task returns a soft-failure result (`done:true, success:false, state, attempts, elapsedMs, error`) instead of throwing. Consumed by this task internally; `BaseTask`'s ignoreFailure translation does not apply to this soft-failure path. See `backend_base_task_design.md` 鎼?.2. |

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `done` | `true` | Flow completion marker |
| `success` | `boolean` | Whether the target state was reached |
| `state` | `"connected" \| "disconnected" \| "unknown"` | Observed final SSH state |
| `attempts` | `number` | Number of SSH probes performed |
| `elapsedMs` | `number` | Total elapsed time in milliseconds |
| `error` | `string \| undefined` | Failure message in the soft-failure return path. Populated by this task itself, not by `BaseTask`. |

### Notes

- `ignoreFailure` is consumed by this task internally to choose between "throw on timeout" and "return soft-failure with partial fields"; `BaseTask`'s ignoreFailure translation does not apply to the soft-failure path. See `backend_base_task_design.md` §2.2.
- Uses `ssh2.Client` connection readiness as the probe signal.
- Uses `robotMdnsDomain` when present, otherwise `robotIp`.
- Does not log passwords or other sensitive credentials.
- Polls until connected or until `timeout` expires.
- Mock variant returns a successful connected state immediately.

---

## 22. WaitSshDisconnectedTask

### Overview

Waits until an SSH session can no longer be established with the robot. This is intended for reboot and upgrade flows where the current SSH service must drop before a later reconnect check.

### Input Parameters

Same as `WaitSshConnectedTask`.

### Output Parameters

Same as `WaitSshConnectedTask`; successful completion returns `state: "disconnected"`.

### Notes

- Uses the same shared SSH probe and wait helper as `WaitSshConnectedTask`.
- A failed SSH connection attempt is treated as the desired disconnected state.
- Polls until disconnected or until `timeout` expires.
- Mock variant returns a successful disconnected state immediately.

---

## 23. WaitSshReconnectTask

### Overview

Waits for a complete SSH reconnect cycle by first waiting for SSH disconnection and then waiting for SSH connection success. This task is a composition task for robot reboot and upgrade flows.

### Input Parameters

Same as `WaitSshConnectedTask`.

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `done` | `true` | Flow completion marker |
| `success` | `boolean` | Whether both disconnect and reconnect phases completed |
| `state` | `"connected" \| "disconnected" \| "unknown"` | Final observed SSH state |
| `disconnectResult` | `ValueMap \| undefined` | Result returned by `WaitSshDisconnectedTask` |
| `connectResult` | `ValueMap \| undefined` | Result returned by `WaitSshConnectedTask` |
| `elapsedMs` | `number` | Total elapsed time in milliseconds |
| `error` | `string \| undefined` | Failure message in the soft-failure return path. Populated by this task itself, not by `BaseTask`. See `backend_base_task_design.md` 鎼?.2. |

### Notes

- Must call `WaitSshDisconnectedTask` followed by `WaitSshConnectedTask`; it must not duplicate the SSH probe loop.
- A single `timeout` value is treated as the total budget for both phases. The reconnect phase receives the remaining timeout after the disconnect phase completes.
- Undefined `timeout` means both phases wait indefinitely.
- `ignoreFailure` is consumed by this task internally (delegating to the underlying wait phases). When true, a phase failure becomes a soft-failure return (`done:true, success:false, state, ...`) instead of a thrown error; `BaseTask`'s ignoreFailure translation does not apply to this soft-failure path. See `backend_base_task_design.md` §2.2.
- Mock variant composes the mock disconnected and connected tasks.

---

## 24. TransferAlpha2MapTask

### Overview

Resolves the Alpha2 map artifact storage path from the artifact service and uploads the artifact file to the robot via SFTP. No intermediate temp directory is used.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `artifactId` | `string` | (optional) | Artifact ID to resolve and transfer |

Inherits all from `SshFileTransferTask`. `sudo` forced to `true`, `remoteFilePath` hardcoded.

### Context Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `artifactService` | `{ getArtifactPath(id): Promise<string> }` | Service to resolve artifact storage path |

### Output Parameters

Same as `SshFileTransferTask`.

### Notes

- Hardcoded remote path: `/home/developer/alpha2_map_package.zip`
- Uses `artifactService.getArtifactPath(artifactId)` to resolve the local file path directly
- If `artifactId` or `artifactService` is absent, falls through to `super.onExec()` directly
- Implementation mirrors `TransferMovebaseTask`

---

## 25. ApplyAlpha2MapTask

### Overview

Executes the Alpha2 map application commands on the remote robot: clears existing map data, extracts the new map zip, and updates directory ownership.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `commandTimeout` | `number` | `60000` (1 min) | Override for map extraction |

Inherits all from `SshCommandTask`. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded 3-step command:
  1. `rm -rf /opt/cosmos/map/ws/*` — clear existing map data
  2. `unzip -o /home/developer/alpha2_map_package.zip -d /opt/cosmos/map/ws` — extract new map package
  3. `chown -R pivot:pivot /opt/cosmos/map/` — update directory ownership
- Commands are `&&`-chained; any step failure fails the entire task
- Default 60-second timeout accommodates map extraction
- The map package is expected at `/home/developer/alpha2_map_package.zip` (transferred by `TransferAlpha2MapTask`)
- After successful application, marie detects the map directory change within ~20 seconds and loads the new map

---

## 26. DeleteAlpha2MapTask

### Overview

Deletes the transferred Alpha2 map package (`/home/developer/alpha2_map_package.zip`) on the remote robot after successful map application.

### Input Parameters

Inherits all from `SshCommandTask`. No additional parameters. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded command: `rm -rf /home/developer/alpha2_map_package.zip`
- Used as the cleanup step in the Alpha2 map application flow
- Implementation mirrors `DeleteMovebaseTask`

---

## 27. TransferIotGatewayConfigTask

### Overview

Transfers the local `iot-gateway-application-prod.yaml` configuration file to `/tmp/iot-gateway-application-prod.yaml` on the remote robot.

### Input Parameters

Inherits all from `SshFileTransferTask`. The `localFilePath` and `remoteFilePath` are hardcoded:

- **localFilePath**: `src/backend/res/iot-gateway-application-prod.yaml` (resolved relative to task module)
- **remoteFilePath**: `/tmp/iot-gateway-application-prod.yaml`
- **sudo**: `true`
- **verifyChecksum**: `false`
- **retryCount**: `1`

### Output Parameters

Same as `SshFileTransferTask`.

### Notes

- Transfers a configuration file (not a script/binary), so checksum verification is disabled
- Single retry is sufficient for configuration file transfers
- The file is placed in `/tmp/` as a staging location before being moved to its final destination by `UpdateIotGatewayConfigTask`

---

## 28. UpdateIotGatewayConfigTask

### Overview

Executes a compound SSH command on the remote robot to:
1. Move the configuration file from `/tmp/` to `/mnt/cosmos/boot/etc/iot-gateway/application-prod.yaml` (overwrites existing)
2. Set file ownership to `iot-gateway:iot-gateway`
3. Clean up APT cache and trusted GPG keys (optional — failures are ignored via `|| true`)
4. Restart `syrius-iot-gateway.service` and `cosmos-update-engine.service` (optional — failures are ignored via `|| true`)

### Input Parameters

Inherits all from `SshCommandTask`. `sudo` forced to `true`. Default `commandTimeout`: 120000ms (2 minutes).

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded 8-step command chained with `&&`:
  1. `mv /tmp/iot-gateway-application-prod.yaml /mnt/cosmos/boot/etc/iot-gateway/application-prod.yaml` — move configuration file
  2. `chown iot-gateway:iot-gateway /mnt/cosmos/boot/etc/iot-gateway/application-prod.yaml` — set ownership
  3. `rm /opt/cosmos/var/cosmos_update_engine/apt/trusted.gpg* || true` — clean trusted GPG keys (optional)
  4. `rm /opt/cosmos/var/cosmos_update_engine/apt/nexus.asc || true` — clean Nexus GPG key (optional)
  5. `rm -rf /var/lib/apt/lists/* || true` — clean APT lists (optional)
  6. `apt clean || true` — clean APT cache (optional)
  7. `systemctl restart syrius-iot-gateway.service || true` — restart iot-gateway service (optional)
  8. `systemctl restart cosmos-update-engine.service || true` — restart update engine service (optional)
- Steps 3-8 use `|| true` to prevent entire command chain from failing when individual cleanup/restart operations fail
- Steps 1-2 are critical (move and chown); if they fail the task fails
- The service restarts take effect after the reboot step in the DAG flow

---

## 29. SshFileDownloadTask

Base class for all SFTP file download tasks.

### Overview

Downloads a remote file from a robot to the local machine via SFTP (ssh2 library). Validates remote file existence via SFTP stat, optionally verifies integrity via checksum comparison (remote before download, local after download), and supports progress logging.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `robotIp` | `string` | (required) | Target robot IP address |
| `robotPort` | `number` | `22` | SSH port |
| `robotMdnsDomain` | `string \| undefined` | `undefined` | mDNS domain |
| `timeout` | `number` | `30000` | General timeout (ms) |
| `retryCount` | `number` | `3` | Max retry attempts |
| `sshUsername` | `string` | `SSH_USERNAME` | SSH login username |
| `sshPassword` | `string` | `SSH_PASSWORD` | SSH login password |
| `remoteFilePath` | `string` | (required) | Remote file path to download |
| `localTargetDir` | `string` | (required) | Local destination directory |
| `verifyChecksum` | `boolean` | `true` | Whether to verify transfer integrity |
| `checksumAlgorithm` | `"sha256" \| "md5"` | `"sha256"` | Checksum algorithm |

### Output Parameters

| Field | Type | Description |
|-------|------|-------------|
| `done` | `true` | Flow completion marker |
| `success` | `true` | Task success marker |
| `bytesTransferred` | `number` | Total bytes transferred |
| `localFilePath` | `string` | Actual saved path (`targetDir/basename`) |
| `localChecksum` | `string` | Local file checksum |
| `remoteChecksum` | `string` | Remote file checksum |
| `integrityVerified` | `boolean` | Whether checksums matched |

### Notes

- Ensures local target directory exists via `mkdir -p` before download
- Verifies remote file exists via SFTP `stat()` before downloading
- Computes remote checksum first (via SSH `exec sha256sum`), then downloads via SFTP `fastGet`, then computes local checksum
- Downloads via SFTP `fastGet` with progress logging every 2 seconds
- File saved as `{localTargetDir}/{basename(remoteFilePath)}`
- Used by the `download-alpha2-sketch` DAG with `remoteFilePath` hardcoded to `/opt/cosmos/map/preview/sketch.zip`

---

## 30. TransferAppTask

### Overview

Resolves the APK artifact storage path from the artifact service and uploads it to the robot via SFTP. Used as the first step of the `Install App` flow.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `artifactId` | `string` | (optional) | Artifact ID to resolve and transfer |

Inherits all from `SshFileTransferTask`. `sudo` forced to `true`, `remoteFilePath` hardcoded.

### Context Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `artifactService` | `{ getArtifactPath(id): Promise<string> }` | Service to resolve artifact storage path |

### Output Parameters

Same as `SshFileTransferTask`.

### Notes

- Hardcoded remote path: `/tmp/app_package.apk`
- Uses `artifactService.getArtifactPath(artifactId)` to resolve the local file path directly (no temp directory created)
- Implementation mirrors `TransferBUPTask`

---

## 31. InstallAppTask

### Overview

Performs the complete APK installation workflow on the remote robot in a single SSH command: ADB auth fix, stop kuaye service, install APK via `adb install -d -r`, restart kuaye service, and cleanup.

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `commandTimeout` | `number` | `300000` (5 min) | Override for long-running install |

Inherits all from `SshCommandTask`. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Combined command chain:
  1. `rm -rf ~/.android/ ; true` — Remove ADB auth directory (failure ignored)
  2. `adb kill-server ; true` — Kill ADB server (failure ignored)
  3. `adb start-server ; true` — Restart ADB server (failure ignored)
  4. `systemctl stop syriusrobotics.kuaye.service ; true` — Stop kuaye service (failure ignored)
  5. **`adb install -d -r /tmp/app_package.apk`** — Install APK (critical step)
  6. `systemctl start syriusrobotics.kuaye.service ; true` — Restart kuaye service (failure ignored)
  7. `rm -f /tmp/app_package.apk ; true` — Cleanup (failure ignored)
- Uses `-d` (downgrade) and `-r` (replace/overwrite) flags
- Only step 5 is critical; all other steps are wrapped with `sh -c "... ; true"` to tolerate failures

---

## 32. CleanupAppTask

### Overview

Deletes the transferred APK file (`/tmp/app_package.apk`) on the remote robot. Used as the error DAG cleanup step when installation fails.

### Input Parameters

Inherits all from `SshCommandTask`. `sudo` forced to `true`.

### Output Parameters

Same as `SshCommandTask`.

### Notes

- Hardcoded command: `rm -f /tmp/app_package.apk`
- Uses `-f` (force) to silently ignore missing files
