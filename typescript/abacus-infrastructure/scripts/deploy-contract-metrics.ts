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
  const chains = await getChainConfigs(environment);
  const domains = Object.keys(chains).map((d) => parseInt(d))
  const chainArray = domains.map((d) => chains[d]);
  return runContractMetricsHelmCommand(
    HelmCommand.Install,
    contractMetricsConfig,
    chainArray,
    environment,
  );
}

main().then(console.log).catch(console.error);
