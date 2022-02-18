import { runContractMetricsHelmCommand } from '../src/contract-metrics';
import { HelmCommand } from '../src/utils/helm';
import {
  getContractMetricsConfig,
  getChainConfigs,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const contractMetricsConfig = await getContractMetricsConfig(environment);
  const chainConfigs = await getChainConfigs(environment);
  return runContractMetricsHelmCommand(
    HelmCommand.Upgrade,
    contractMetricsConfig,
    chainConfigs,
  );
}

main().then(console.log).catch(console.error);
