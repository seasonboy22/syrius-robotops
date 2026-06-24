import type { ValueMap } from "flowed";
import { TransferAppTask } from "../real/transferAppTask.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockTransferAppTask extends TransferAppTask {
  protected override async onExec(params: ValueMap): Promise<ValueMap> {
    this.log.info("Simulating app transfer (mock)");
    await sleep(1000);
    this.log.info("App transfer completed (mock)");
    return {
      done: true,
      success: true,
      bytesTransferred: 50_000_000,
      localChecksum: "mock-sha256",
      remoteChecksum: "mock-sha256",
      integrityVerified: true,
    };
  }
}
