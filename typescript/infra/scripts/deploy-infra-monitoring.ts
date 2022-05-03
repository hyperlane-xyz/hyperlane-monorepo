import { runPrometheusHelmCommand } from '../src/infrastructure/monitoring/prometheus';
import { HelmCommand } from '../src/utils/helm';

import { getEnvironment, getInfrastructureConfig } from './utils';

async function main() {
  const environment = await getEnvironment();
  const infraConfig = await getInfrastructureConfig(environment);
  return runPrometheusHelmCommand(
    HelmCommand.InstallOrUpgrade,
    infraConfig,
    environment,
  );
}

main().then(console.log).catch(console.error);
