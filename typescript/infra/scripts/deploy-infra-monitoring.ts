import { getEnvironment, getCoreEnvironmentConfig } from './utils';
import { runPrometheusHelmCommand } from '../src/infrastructure/monitoring/prometheus';
import { HelmCommand } from '../src/utils/helm';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  return runPrometheusHelmCommand(
    HelmCommand.Install,
    config.infra,
    environment,
  );
}

main().then(console.log).catch(console.error);
