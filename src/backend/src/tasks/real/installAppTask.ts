import type { ValueMap } from "flowed";
import { SshCommandTask, type SshCommandParams } from "./sshCommandTask.js";

const INSTALL_COMMAND = [
  `sh -c "rm -rf ~/.android/ ; true"`,
  `sh -c "adb kill-server ; true"`,
  `sh -c "adb start-server ; true"`,
  `sh -c "systemctl stop syriusrobotics.kuaye.service ; true"`,
  "adb install -d -r /tmp/app_package.apk",
  `sh -c "systemctl start syriusrobotics.kuaye.service ; true"`,
  `sh -c "rm -f /tmp/app_package.apk ; true"`,
].join(" && ");

export class InstallAppTask extends SshCommandTask {
  protected override buildParams(params: ValueMap): SshCommandParams {
    return super.buildParams({
      ...params,
      sudo: true,
      commandTimeout: (params.commandTimeout as number) ?? 300000,
    });
  }

  protected override getSshCommand(_params: ValueMap): string {
    return INSTALL_COMMAND;
  }
}

export class CleanupAppTask extends SshCommandTask {
  protected override buildParams(params: ValueMap): SshCommandParams {
    return super.buildParams({ ...params, sudo: true });
  }

  protected override getSshCommand(_params: ValueMap): string {
    return "rm -f /tmp/app_package.apk";
  }
}
