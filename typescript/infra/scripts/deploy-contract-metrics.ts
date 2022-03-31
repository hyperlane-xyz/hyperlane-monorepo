import { runContractMetricsHelmCommand } from '../src/contract-metrics';
import { HelmCommand } from '../src/utils/helm';
import {
  getContractMetricsConfig,
  getDomainNames,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const contractMetricsConfig = await getContractMetricsConfig(environment);
  const domainNames = await getDomainNames(environment);
  return runContractMetricsHelmCommand(
    HelmCommand.Install,
    contractMetricsConfig,
    domainNames,
    environment,
  );
}

main().then(console.log).catch(console.error);
