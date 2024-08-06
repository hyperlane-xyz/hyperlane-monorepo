import { runPrometheusHelmCommand } from '../src/infrastructure/monitoring/prometheus.js';
import { HelmCommand } from '../src/utils/helm.js';

import { assertCorrectKubeContext, getArgs } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);
  return runPrometheusHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.infra,
    environment,
  );
}

main().then(console.log).catch(console.error);
