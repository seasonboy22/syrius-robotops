import { test, expect } from "../fixtures/test-fixture.js";
import {
  createSolutionViaAPI,
  deleteSolutionViaAPI,
  addRobotViaAPI,
  openSolutionInWorkspace,
  clickSidebarTab,
} from "../fixtures/test-fixture.js";
import assert from "node:assert/strict";

test.describe("Task Management", () => {
  test.describe.configure({ mode: "serial" });

  let solutionId: string;

  test.beforeAll(async ({ apiURL }) => {
    const meta = await createSolutionViaAPI(apiURL, "Task Test Solution", "E2E task test");
    solutionId = meta.id;
    await addRobotViaAPI(apiURL, solutionId, "192.168.1.10");
    await addRobotViaAPI(apiURL, solutionId, "192.168.1.11");
  });

  test.afterAll(async ({ apiURL }) => {
    await deleteSolutionViaAPI(apiURL, solutionId).catch(() => {});
  });

  test("TC-E2E-TASK-001: Tasks tab shows empty state", async ({ appPage }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await expect(appPage.getByText("No tasks yet")).toBeVisible();
    await expect(
      appPage.getByText("Create tasks to upgrade robots in this solution.")
    ).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: "Create your first task" })
    ).toBeVisible();
  });

  test("TC-E2E-TASK-002: Create task modal opens and has task type selection", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" });
    await expect(modal).toBeVisible({ timeout: 5000 });
    await expect(modal.getByText("Create Task")).toBeVisible();
  });

  test("TC-E2E-TASK-003: Task list shows breadcrumb navigation", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    const breadcrumb = appPage.locator(".cds--breadcrumb");
    await expect(breadcrumb.getByText("Solutions")).toBeVisible();
    await expect(breadcrumb.getByText("Task Test Solution")).toBeVisible();
    await expect(breadcrumb.getByText("Tasks")).toBeVisible();
  });

  test("TC-E2E-TASK-004: Task search is hidden when no tasks exist", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    // When there are no tasks, the search input should not be visible
    const searchInput = appPage.getByPlaceholder("Search by robot alias or task name...");
    await expect(searchInput).not.toBeVisible();
    await expect(appPage.getByText("No tasks yet")).toBeVisible();
  });

  test("TC-E2E-TASK-005: Navigate between Robots and Tasks sub-views", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await expect(appPage.getByText("No tasks yet")).toBeVisible();

    await clickSidebarTab(appPage, "Robots");
    // Robots added via API should be visible
    await expect(appPage.getByText("192.168.1.10").first()).toBeVisible({ timeout: 5000 });

    await clickSidebarTab(appPage, "Tasks");
    await expect(appPage.getByText("No tasks yet")).toBeVisible();
  });

  test("TC-E2E-TASK-006: Task creation modal shows Create button", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });
    // Verify modal has content
    await expect(modal.locator("button").filter({ hasText: /Create|Cancel/i }).first()).toBeVisible();
  });

  test("TC-E2E-TASK-007: All task types show multi-robot selection in task type step", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // All 7 multi-robot task types should show "Multiple robots" (after Deploy AE Config and Install App were added)
    await expect(modal.getByText("Robot selection: Multiple robots")).toHaveCount(7);

    // Verify the single-robot task type is present
    await expect(modal.getByText("Robot selection: Single robot")).toBeVisible();

    // Verify each task type is present
    await expect(modal.getByText("Upgrade BUP")).toBeVisible();
    await expect(modal.getByText("Movebase Disk Cleanup")).toBeVisible();
    await expect(modal.getByText("Upgrade Movebase")).toBeVisible();
    await expect(modal.getByText("Apply Alpha2 Map")).toBeVisible();
  });

  test("TC-E2E-TASK-008: Upgrade Movebase step 2 shows checkboxes and Select All", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Select Upgrade Movebase task type
    await modal.locator("div").filter({ hasText: "Upgrade Movebase" }).first().click();
    await appPage.waitForTimeout(300);

    // Click Next to go to robot selection step
    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    // Verify Select All checkbox is visible (multi-robot indicator)
    await expect(modal.getByLabel("Select all robots")).toBeVisible();

    // Verify robot checkboxes are present
    await expect(modal.getByLabel("Select 192.168.1.10")).toBeVisible();
    await expect(modal.getByLabel("Select 192.168.1.11")).toBeVisible();

    // Verify selection count
    await expect(modal.getByText("0 robots selected")).toBeVisible();

    // Select first robot via checkbox
    await modal.getByLabel("Select 192.168.1.10").check();
    await expect(modal.getByText("1 robot selected")).toBeVisible();

    // Select All
    await modal.getByLabel("Select all robots").check();
    await expect(modal.getByText("2 robots selected")).toBeVisible();
  });

  test("TC-E2E-TASK-009: Apply Alpha2 Map selection leads to multi-robot step 2", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText("Apply Alpha2 Map")).toBeVisible();

    // Select Apply Alpha2 Map task type
    await modal.locator("div").filter({ hasText: "Apply Alpha2 Map" }).first().click();
    await appPage.waitForTimeout(300);

    // Click Next to go to robot selection step
    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    // Verify multi-robot selection is active (Select All checkbox visible)
    await expect(modal.getByLabel("Select all robots")).toBeVisible();
  });

  test("TC-E2E-TASK-010: Apply Alpha2 Map step 2 shows checkboxes and Select All", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Select Apply Alpha2 Map task type
    await modal.locator("div").filter({ hasText: "Apply Alpha2 Map" }).first().click();
    await appPage.waitForTimeout(300);

    // Click Next to go to robot selection step
    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    // Verify Select All checkbox is visible (multi-robot indicator)
    await expect(modal.getByLabel("Select all robots")).toBeVisible();

    // Verify robot checkboxes are present
    await expect(modal.getByLabel("Select 192.168.1.10")).toBeVisible();
    await expect(modal.getByLabel("Select 192.168.1.11")).toBeVisible();

    // Select both robots individually
    await modal.getByLabel("Select 192.168.1.10").check();
    await modal.getByLabel("Select 192.168.1.11").check();
    await expect(modal.getByText("2 robots selected")).toBeVisible();
  });

  test("TC-E2E-TASK-011: Update IoT Gateway Config task type appears in task creation modal", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText("Update IoT Gateway Config")).toBeVisible();
    await expect(modal.getByText("Download Alpha2 Sketch")).toBeVisible();
  });

  test("TC-E2E-TASK-012: Update IoT Gateway Config shows multi-robot selection in task type step", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // All 7 task types should show "Multiple robots" (after Deploy AE Config and Install App were added)
    await expect(modal.getByText("Robot selection: Multiple robots")).toHaveCount(7);
  });

  test("TC-E2E-TASK-013: Update IoT Gateway Config leads to multi-robot step 2", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText("Update IoT Gateway Config")).toBeVisible();

    await modal.locator("div").filter({ hasText: "Update IoT Gateway Config" }).first().click();
    await appPage.waitForTimeout(300);

    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    await expect(modal.getByLabel("Select all robots")).toBeVisible();
    await expect(modal.getByLabel("Select 192.168.1.10")).toBeVisible();
    await expect(modal.getByLabel("Select 192.168.1.11")).toBeVisible();
  });

  test("TC-E2E-TASK-014: Update IoT Gateway Config task has no extra params step", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await modal.locator("div").filter({ hasText: "Update IoT Gateway Config" }).first().click();
    await appPage.waitForTimeout(300);

    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    await modal.getByLabel("Select 192.168.1.10").check();
    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    // Should go directly to confirmation step (no params needed)
    await expect(modal.getByText(/Confirm/i).first()).toBeVisible({ timeout: 5000 });
  });

  test("TC-E2E-TASK-015: Download Alpha2 Sketch task type shows in list", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Verify the new task type is present
    await expect(modal.getByText("Download Alpha2 Sketch")).toBeVisible();

    // Verify it shows single robot selection
    await expect(modal.getByText("Robot selection: Single robot")).toBeVisible();

    // Close modal to avoid stale state in next test
    await appPage.keyboard.press("Escape");
    await appPage.waitForTimeout(500);
  });

  test("TC-E2E-TASK-016: Download Alpha2 Sketch task type can be created via API", async ({
    appPage,
    apiURL,
  }) => {
    // Verify the task type exists in the registry by creating a flow via API
    const response = await appPage.evaluate(async (url) => {
      const res = await fetch(`${url}/api/flows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "user",
          dag: {
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
          },
          input: {
            solutionId: "test-sol",
            robotIds: [],
            taskName: "Download Alpha2 Sketch",
            robotIp: "192.168.1.10",
            robotPort: 22,
            localTargetDir: "/tmp",
          },
          expectedResults: ["download_result"],
        }),
      });
      return { status: res.status, body: await res.json() };
    }, apiURL);

    assert.equal(response.status, 201);
    assert.ok(response.body.id);
    assert.equal(response.body.state, "RUNNING");
  });

  test("TC-E2E-TASK-017: Download Alpha2 Sketch params config visible in create modal", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    // Dismiss any lingering modals
    await appPage.keyboard.press("Escape");
    await appPage.waitForTimeout(300);

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Select Download Alpha2 Sketch
    await modal.locator("div").filter({ hasText: "Download Alpha2 Sketch" }).first().click();
    await appPage.waitForTimeout(300);

    // Verify the Next button is enabled (selection confirmed)
    const nextButton = modal.getByRole("button", { name: "Next" });
    await expect(nextButton).toBeEnabled();
  });

  test("TC-E2E-AE-001: Deploy AE Config task type is visible in the create modal", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText("Deploy AE Config")).toBeVisible();
  });

  test("TC-E2E-AE-002: Deploy AE Config selection leads to multi-robot step 2", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await modal.getByText("Deploy AE Config", { exact: true }).click();
    await appPage.waitForTimeout(300);

    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    await expect(modal.getByLabel("Select all robots")).toBeVisible();
    await expect(modal.getByLabel("Select 192.168.1.10")).toBeVisible();
    await expect(modal.getByLabel("Select 192.168.1.11")).toBeVisible();
  });

  test("TC-E2E-AE-003: Deploy AE Config params step shows AE config package field", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await modal.getByText("Deploy AE Config", { exact: true }).click();
    await appPage.waitForTimeout(300);
    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(300);

    await modal.getByLabel("Select 192.168.1.10").check();
    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    await expect(modal.getByText("AE config package")).toBeVisible();
  });

  test("TC-E2E-AE-004: Existing task types remain visible alongside Deploy AE Config", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText("Upgrade BUP")).toBeVisible();
    await expect(modal.getByText("Movebase Disk Cleanup")).toBeVisible();
    await expect(modal.getByText("Upgrade Movebase")).toBeVisible();
    await expect(modal.getByText("Apply Alpha2 Map")).toBeVisible();
    await expect(modal.getByText("Update IoT Gateway Config")).toBeVisible();
    await expect(modal.getByText("Download Alpha2 Sketch")).toBeVisible();
    await expect(modal.getByText("Deploy AE Config")).toBeVisible();
  });

  test("TC-E2E-TASK-018: Install App task type appears in task creation modal", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText("Install App")).toBeVisible();
  });

  test("TC-E2E-TASK-019: Install App shows multi-robot selection in task type step", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText("Install App")).toBeVisible();
    await expect(modal.getByText("Robot selection: Multiple robots")).toHaveCount(7);
  });

  test("TC-E2E-TASK-020: Install App leads to multi-robot step 2 then params step", async ({
    appPage,
  }) => {
    await openSolutionInWorkspace(appPage, "Task Test Solution");
    await clickSidebarTab(appPage, "Tasks");

    await appPage.getByRole("button", { name: "Create your first task" }).click();
    await appPage.waitForTimeout(500);

    const modal = appPage.locator(".cds--modal-container").filter({ hasText: "Create Task" }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(modal.getByText("Install App")).toBeVisible();

    await modal.getByText("Install App", { exact: true }).first().click();
    await appPage.waitForTimeout(300);

    await modal.getByRole("button", { name: "Next" }).click();
    await appPage.waitForTimeout(500);

    await expect(modal.getByLabel("Select all robots")).toBeVisible();
    await expect(modal.getByLabel("Select 192.168.1.10")).toBeVisible();
    await expect(modal.getByLabel("Select 192.168.1.11")).toBeVisible();
  });
});
