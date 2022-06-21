import { runPrometheusHelmCommand } from '../src/infrastructure/monitoring/prometheus';
import { HelmCommand } from '../src/utils/helm';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  return runPrometheusHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.infra,
    environment,
  );
}

main().then(console.log).catch(console.error);
