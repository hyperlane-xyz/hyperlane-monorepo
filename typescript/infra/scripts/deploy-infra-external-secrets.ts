import { runExternalSecretsHelmCommand } from '../src/infrastructure/external-secrets/external-secrets';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getCoreEnvironmentConfig,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);
  return runExternalSecretsHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.infra,
    environment,
  );
}

main().then(console.log).catch(console.error);
