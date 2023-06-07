import { runExternalSecretsHelmCommand } from '../src/infrastructure/external-secrets/external-secrets';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getArgs,
  getEnvironmentConfig,
} from './utils';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);
  return runExternalSecretsHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.infra,
    environment,
  );
}

main().then(console.log).catch(console.error);
