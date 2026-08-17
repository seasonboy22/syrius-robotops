import type { ValueMap } from "flowed";
import { SshCommandTask, type SshCommandParams, type SshCommandResult } from "./sshCommandTask.js";

const INSTALL_SCRIPT = `
if adb devices | grep -qE "\\s+device$"; then
  echo "[install-app] ADB already authorized, using direct path"
  systemctl stop syriusrobotics.kuaye.service || true
  adb install -d -r /tmp/app_package.apk
  systemctl start syriusrobotics.kuaye.service || true
else
  echo "[install-app] ADB not authorized, resetting ADB server"
  rm -rf ~/.android/ || true
  adb kill-server || true
  adb start-server || true
  chown -R "\${SUDO_USER:-$USER}:\${SUDO_USER:-$USER}" ~/.android/ || true
  sleep 3
  systemctl stop syriusrobotics.kuaye.service || true
  adb install -d -r /tmp/app_package.apk
  systemctl start syriusrobotics.kuaye.service || true
fi
rm -f /tmp/app_package.apk || true
`.trim();

const INSTALL_COMMAND = `sh -c '${INSTALL_SCRIPT}'`;

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

  protected override isCommandSuccessful(result: SshCommandResult): boolean {
    if (super.isCommandSuccessful(result)) {
      return true;
    }
    if (result.exitCode === undefined && result.stdout.includes("Success")) {
      this.log.info(
        { exitCode: result.exitCode },
        "ADB install reported Success despite undefined exit code, treating as success"
      );
      return true;
    }
    return false;
  }
}
