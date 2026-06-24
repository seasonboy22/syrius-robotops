# App Installation (GGR/APK) — Requirements Specification

## 1. Overview

This feature allows FAEs to upload an APK artifact (e.g., GGR/GoGoReadyLauncher) to a remote robot and install it via RobotOps Studio. The installation workflow handles ADB authorization resets, service management, APK overwrite installation, and cleanup.

**Key Workflow**:
1. User uploads an APK artifact via the Artifacts page
2. User creates an "Install App" task, selects the artifact and target robot(s)
3. System uploads the APK to the robot via SFTP (`/tmp/app_package.apk`)
4. System runs the installation command chain:
   - Reset ADB authorization (`rm -rf ~/.android/; adb kill-server; adb start-server`)
   - Stop kuaye service (`systemctl stop syriusrobotics.kuaye.service`)
   - Install APK with overwrite + downgrade (`adb install -d -r /tmp/app_package.apk`)
   - Start kuaye service (`systemctl start syriusrobotics.kuaye.service`)
   - Cleanup uploaded APK (`rm -f /tmp/app_package.apk`)
5. On failure, the error DAG runs cleanup to remove the APK file

---

## 2. Terminology

| Term | Definition |
|------|------------|
| **APK** | Android Package Kit — the application package file to be installed |
| **GGR** | GoGoReadyLauncher — the main launcher application APK |
| **kuaye service** | `syriusrobotics.kuaye.service` — the service connecting to the lower computer |
| **ADB** | Android Debug Bridge — used to install the APK on the robot's Android subsystem |
| **Installation Task** | A Task Flow Engine task that executes the APK installation pipeline |

---

## 3. Functional Requirements

### FR-01: Task Type Definition

The system must provide an "Install App" task type in the task selector with:
- **Name**: `Install App`
- **Description**: `Install or upgrade an app on selected robots.`
- **Robot Selection**: Multi-robot mode (`mode: "multiple"`)

### FR-02: Artifact Selection

- The task requires an APK artifact to be uploaded to the Artifact Manager first
- Frontend shows an `ArtifactSelector` modal for picking the APK artifact
- The selected `artifactId` is passed to the task DAG

### FR-03: APK Transfer

- System downloads the artifact from the artifact service to a temporary directory
- System uploads the APK to the robot via SFTP to `/tmp/app_package.apk`
- Transfer uses SHA-256 checksum verification by default
- Supports retry (3 attempts with linear backoff)

### FR-04: Installation Command Chain

The system executes the following commands on the remote robot in order:

| Step | Command | Failure Handling |
|------|---------|-----------------|
| 1 | `rm -rf ~/.android/ ; true` | Ignored on failure |
| 2 | `adb kill-server ; true` | Ignored on failure |
| 3 | `adb start-server ; true` | Ignored on failure |
| 4 | `systemctl stop syriusrobotics.kuaye.service ; true` | Ignored on failure |
| 5 | `adb install -d -r /tmp/app_package.apk` | **Critical** — failure fails the task |
| 6 | `systemctl start syriusrobotics.kuaye.service ; true` | Ignored on failure |
| 7 | `rm -f /tmp/app_package.apk ; true` | Ignored on failure |

### FR-05: ADB Authorization Reset

Before installation, the system resets ADB authorization by:
1. Removing the `.android/` directory
2. Killing the ADB server
3. Starting the ADB server fresh

This resolves "unauthorized" device issues caused by stale ADB keys.

### FR-06: Install Flags

The APK is installed with:
- `-d` — Allow version downgrade
- `-r` — Replace existing application (overwrite install)

### FR-07: Error DAG

- If the installation task (`InstallAppTask`) fails, the error DAG runs `CleanupAppTask`
- `CleanupAppTask` removes `/tmp/app_package.apk` on the robot
- This prevents leftover APK files after failed installations

### FR-08: Task Status Feedback

- Real-time status updates via SSE (task running, completed, failed)
- Success indicator shows when installation completes
- Partial step failures (non-install steps) are tolerated

### FR-09: Mock Mode Support

- In `--mock` mode, all tasks simulate execution without SSH connection
- `MockTransferAppTask` simulates 1s transfer and returns mock checksums
- `MockInstallAppTask` simulates the full installation sequence (~8s) and returns success
- `MockCleanupAppTask` simulates 0.5s cleanup

---

## 4. Non-Functional Requirements

### NFR-01: Code Standards

- TypeScript + ES6 module syntax throughout
- Follow existing `BaseTask` / `SshCommandTask` / `SshFileTransferTask` architecture
- Logging via Pino (`this.log`), never `console.log`
- All logs and comments in English

### NFR-02: Error Handling

- SSH connection failure → retry 3 times then throw
- APK transfer failure → retry 3 times then throw
- ADB install failure (exit code != 0) → task fails
- Non-critical step failures (ADB reset, service stop/start, cleanup) → silently ignored
- Missing artifact → clear error message

### NFR-03: Security

- SSH credentials are never logged
- APK files are cleaned up from both temp directory and robot after transfer/installation
- No sensitive data exposure in API responses

### NFR-04: Timeout

- Default command timeout: 300000ms (5 minutes) for installation
- Transfer timeout: 30000ms (30s default) per connection

---

## 5. Constraints

- Requires SSH service on the robot (port 22)
- Requires ADB on the robot (Android Debug Bridge)
- Requires `syriusrobotics.kuaye.service` to be manageable via systemd
- Robot must be accessible via DLB (Direct Link Bridge) network
- Only APK files supported (`.apk` format)
