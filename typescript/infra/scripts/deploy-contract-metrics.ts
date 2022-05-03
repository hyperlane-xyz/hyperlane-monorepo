import { ChainName } from '@abacus-network/sdk';

import { runContractMetricsHelmCommand } from '../src/contract-metrics';
import { HelmCommand } from '../src/utils/helm';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  return runContractMetricsHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.metrics,
    Object.keys(config.transactionConfigs) as ChainName[],
    environment,
  );
}

main().then(console.log).catch(console.error);
