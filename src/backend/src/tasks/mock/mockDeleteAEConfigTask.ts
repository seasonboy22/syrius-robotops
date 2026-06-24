import type { ValueMap } from "flowed";
import { DeleteAEConfigTask } from "../real/deleteAEConfigTask.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockDeleteAEConfigTask extends DeleteAEConfigTask {
  protected override async onExec(_params: ValueMap): Promise<ValueMap> {
    this.log.info('Simulating AE config cleanup (mock)');

    await sleep(1000);

    this.log.info('Cleanup completed (mock)');

    return {
      done: true,
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
  }
}
