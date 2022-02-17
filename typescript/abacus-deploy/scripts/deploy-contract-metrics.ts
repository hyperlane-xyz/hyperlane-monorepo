import { runContractMetricsHelmCommand } from '../src/contract-metrics';
import { HelmCommand } from '../src/utils/helm';
import { getAgentConfig, getChainConfigs, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const chainConfigs = await getChainConfigs(environment);
  const agentConfig = await getAgentConfig(environment);
  return runContractMetricsHelmCommand(
    HelmCommand.Install,
    chainConfigs,
    agentConfig.namespace,
    environment,
  );
}

main().then(console.log).catch(console.error);
