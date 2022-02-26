import { getInfrastructureConfig, getEnvironment } from './utils';
import { runPrometheusHelmCommand } from '../src/infrastructure/monitoring/prometheus';
import { HelmCommand } from '../src/utils/helm';

async function main() {
  const environment = await getEnvironment();
  const infraConfig = await getInfrastructureConfig(environment);
  return runPrometheusHelmCommand(
    HelmCommand.Install,
    infraConfig,
    environment,
  );
}

main().then(console.log).catch(console.error);
