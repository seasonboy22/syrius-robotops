import type { ValueMap } from "flowed";
import { InstallAppTask } from "../real/installAppTask.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockInstallAppTask extends InstallAppTask {
  protected override async onExec(_params: ValueMap): Promise<ValueMap> {
    this.log.info("Simulating ADB auth fix (mock)");
    await sleep(500);
    this.log.info("Simulating stop kuaye service (mock)");
    await sleep(1000);
    this.log.info("Simulating adb install (mock)");
    await sleep(5000);
    this.log.info("Simulating start kuaye service (mock)");
    await sleep(1000);
    this.log.info("Simulating cleanup (mock)");
    await sleep(500);
    this.log.info("App install completed (mock)");
    return {
      done: true,
      success: true,
      stdout: "Success",
      stderr: "",
      exitCode: 0,
    };
  }
}

export class MockCleanupAppTask extends MockInstallAppTask {
  protected override async onExec(_params: ValueMap): Promise<ValueMap> {
    this.log.info("Simulating cleanup (mock)");
    await sleep(500);
    return {
      done: true,
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
  }
}
