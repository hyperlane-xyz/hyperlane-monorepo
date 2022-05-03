import { ChainName } from '@abacus-network/sdk';

import { runKeymasterHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const domains = Object.keys(config.transactionConfigs) as ChainName[];
  return runKeymasterHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.agent,
    domains,
  );
}

main().then(console.log).catch(console.error);
