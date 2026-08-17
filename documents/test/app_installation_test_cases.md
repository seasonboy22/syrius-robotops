# App Installation — Test Case Design Document

## 1. Overview

This document defines test cases for the "Install App" APK installation feature, covering backend unit tests and frontend E2E tests.

---

## 2. Backend Unit Tests

Test execution command: `npm --workspace backend run test` (from `src/`)

### TC-APP-001: TransferApp task uploads APK to correct remote path

**Precondition**: None

**Test Steps**:
1. Create `TestableTransferAppTask` instance
2. Call `buildParams()` with `{ robotIp: "192.168.1.10", artifactId: "test-apk-id" }`

**Expected Result**:
- `remoteFilePath` equals `/tmp/app_package.apk`
- `sudo` is `true`

### TC-APP-002: InstallApp command is wrapped in a single sh -c script

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Call `getSshCommand()` to get the generated command

**Expected Result**:
- Command starts with `sh -c '`

### TC-APP-003: InstallApp uses sudo=true

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Call `buildParams()` with `{ robotIp: "192.168.1.10" }`

**Expected Result**: `sudo` is `true`

### TC-APP-004: InstallApp defaults commandTimeout to 5 minutes

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Call `buildParams()` with `{ robotIp: "192.168.1.10" }`

**Expected Result**: `commandTimeout` equals `300000`

### TC-APP-005: InstallApp checks ADB authorization before choosing the install path

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Get the generated command

**Expected Result**:
- Command contains `adb devices | grep -qE`

### TC-APP-005b: InstallApp skips ADB reset when a device is already authorized

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Get the generated command

**Expected Result**:
- Direct install path (`systemctl stop` then `adb install`) appears before the `else` branch
- ADB reset commands (`rm -rf ~/.android/`, `adb kill-server`, `adb start-server`) only appear after `else`

### TC-APP-005c: InstallApp resets ADB server and waits 3s when no authorized device

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Get the generated command

**Expected Result**:
- `else` branch contains `rm -rf ~/.android/`
- `else` branch contains `adb kill-server`
- `else` branch contains `adb start-server`
- `else` branch contains `sleep 3`
- `else` branch contains `adb install -d -r /tmp/app_package.apk`

### TC-APP-005d: InstallApp cleanup runs in both branches

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Get the generated command

**Expected Result**:
- Command contains `rm -f /tmp/app_package.apk`

### TC-APP-005e: InstallApp fixes ~/.android/ ownership after ADB reset

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Get the generated command

**Expected Result**:
- `else` branch contains `chown -R "${SUDO_USER:-$USER}:${SUDO_USER:-$USER}" ~/.android/`

### TC-APP-005f: InstallApp treats undefined exit code as success when adb reports Success

**Precondition**: None

**Test Steps**:
1. Create `TestableInstallAppTask` instance
2. Call `isCommandSuccessful()` with `exitCode: undefined` and stdout containing `Success`
3. Call `isCommandSuccessful()` with `exitCode: undefined` and stdout not containing `Success`
4. Call `isCommandSuccessful()` with `exitCode: 0`
5. Call `isCommandSuccessful()` with `exitCode: 1`

**Expected Result**:
- `undefined` exit code with `Success` in stdout returns `true`
- `undefined` exit code without `Success` returns `false`
- `exitCode: 0` returns `true`
- `exitCode: 1` returns `false`

### TC-APP-006: CleanupApp generates correct cleanup command

**Precondition**: None

**Test Steps**:
1. Create `TestableCleanupAppTask` instance
2. Call `getSshCommand()` to get the cleanup command

**Expected Result**: Command equals `rm -f /tmp/app_package.apk`

### TC-APP-007: CleanupApp uses sudo=true

**Precondition**: None

**Test Steps**:
1. Create `TestableCleanupAppTask` instance
2. Call `buildParams()` with `{ robotIp: "192.168.1.10" }`

**Expected Result**: `sudo` is `true`

### TC-APP-008: 2-step install-app DAG completes successfully

**Precondition**: Mock tasks registered in engine

**Test Steps**:
1. Create `TaskFlowEngine` with mock registry
2. Register `MockTransferAppTask`, `MockInstallAppTask`, `MockCleanupAppTask`
3. Create flow with install-app DAG (transfer → install)
4. Wait for flow to complete

**Expected Result**:
- Flow reaches `COMPLETED` state
- `transfer` task is `COMPLETED`
- `install` task is `COMPLETED`

### TC-APP-009: Error DAG cleanup runs when install fails

**Precondition**: Mock tasks with failing install registered in engine

**Test Steps**:
1. Create `TaskFlowEngine` with mock registry
2. Register `MockTransferAppTask`, `FailingMockInstallTask`, `MockCleanupAppTask`
3. Create flow with install-app DAG and error DAG
4. Wait for flow to complete

**Expected Result**:
- Flow reaches `FAILED` state
- `phase` is `error`
- Error handling completed event is emitted

---

## 3. E2E Test Cases

Test execution command: `npm run test:e2e` (from `src/`)

### TC-E2E-TASK-018: Install App task type appears in task creation modal

**Precondition**:
- Test Solution created with 2 robots added
- Tasks tab open

**Test Steps**:
1. Click "Create your first task" button
2. Look for "Install App" in task type list

**Expected Result**: "Install App" is visible in task type list

### TC-E2E-TASK-019: Install App shows multi-robot selection

**Precondition**: Task creation modal open

**Test Steps**:
1. Check modal content

**Expected Result**:
- "Install App" is visible
- "Robot selection: Multiple robots" appears with count matching multi-robot task types

### TC-E2E-TASK-020: Install App leads to multi-robot step 2 then params step

**Precondition**: Task creation modal open

**Test Steps**:
1. Click "Install App" task type
2. Click "Next"
3. Check robot selection checkboxes are visible
4. Select a robot
5. Click "Next"
6. Check params step

**Expected Result**:
- "Select all robots" checkbox visible
- Robot checkboxes (192.168.1.10, 192.168.1.11) visible
- "Artifact file" label visible in params step

---

## 4. Test Data

| Data Item | Value | Description |
|-----------|-------|-------------|
| Test robot IP | `192.168.1.10` | Virtual address for E2E tests |
| Test robot IP 2 | `192.168.1.11` | Second robot for multi-robot tests |
| Remote APK path | `/tmp/app_package.apk` | Fixed transfer destination |
| APK install path | `adb install -d -r /tmp/app_package.apk` | Install command |
| Command timeout | `300000` ms (5 min) | Default install timeout |
| Mock transfer delay | `1000` ms | Mock APK transfer time |
| Mock install delay | `~8000` ms | Mock installation simulation time |

---

## 5. Test Coverage

| Module | Coverage Target |
|--------|----------------|
| `TransferAppTask` | `buildParams()`, `onExec()` artifact resolution |
| `InstallAppTask` | `buildParams()`, `getSshCommand()` |
| `CleanupAppTask` | `buildParams()`, `getSshCommand()` |
| `MockTransferAppTask` | Return value structure |
| `MockInstallAppTask` | Return value structure |
| `MockCleanupAppTask` | Return value structure |
| DAG Flow Integration | Flow creation, completion, error handling |
| Frontend Task Selector | UI render, step navigation |
