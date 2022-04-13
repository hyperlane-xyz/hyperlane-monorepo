import { runContractMetricsHelmCommand } from '../src/contract-metrics';
import { HelmCommand } from '../src/utils/helm';
import { getEnvironment, getCoreEnvironmentConfig } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  return runContractMetricsHelmCommand(
    HelmCommand.Install,
    config.metrics,
    config.domains,
    environment,
  );
}

main().then(console.log).catch(console.error);
