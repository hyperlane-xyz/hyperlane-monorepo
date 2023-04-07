import { runPrometheusHelmCommand } from '../src/infrastructure/monitoring/prometheus';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getEnvironment,
  getEnvironmentConfig,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);
  return runPrometheusHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.infra,
    environment,
  );
}

main().then(console.log).catch(console.error);
