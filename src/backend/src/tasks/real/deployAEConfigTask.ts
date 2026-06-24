import type { ValueMap } from "flowed";
import { SshCommandTask, type SshCommandParams } from "./sshCommandTask.js";

const REMOTE_PACKAGE_PATH = "/tmp/ae_config_package.zip";
const REMOTE_DEPLOY_DIR = "/opt/cosmos/bin/applet-engine";
const DEPLOY_OWNER = "cosmos:cosmos";
const AE_SERVICE_NAME = "cosmos-applet-engine.service";

export class DeployAEConfigTask extends SshCommandTask {
  protected override buildParams(params: ValueMap): SshCommandParams {
    return super.buildParams({
      ...params,
      sudo: true,
      commandTimeout: (params.commandTimeout as number) ?? 60000,
      retryCount: 1,
    });
  }

  protected override getSshCommand(_params: ValueMap): string {
    return [
      `[ -d ${REMOTE_DEPLOY_DIR} ] || { echo "Deploy target not found: ${REMOTE_DEPLOY_DIR}" >&2; exit 1; }`,
      `unzip -o ${REMOTE_PACKAGE_PATH} -d ${REMOTE_DEPLOY_DIR}`,
      `chown -R ${DEPLOY_OWNER} ${REMOTE_DEPLOY_DIR}`,
      `systemctl restart ${AE_SERVICE_NAME}`,
      `rm -f ${REMOTE_PACKAGE_PATH}`,
    ].join(" && ");
  }
}
