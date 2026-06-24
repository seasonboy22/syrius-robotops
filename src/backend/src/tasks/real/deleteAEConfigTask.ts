import type { ValueMap } from "flowed";
import { SshCommandTask, type SshCommandParams } from "./sshCommandTask.js";

const DELETE_AE_CONFIG_COMMAND = "rm -f /tmp/ae_config_package.zip";

export class DeleteAEConfigTask extends SshCommandTask {
  protected override buildParams(params: ValueMap): SshCommandParams {
    return super.buildParams({ ...params, sudo: true });
  }

  protected override getSshCommand(_params: ValueMap): string {
    return DELETE_AE_CONFIG_COMMAND;
  }
}
