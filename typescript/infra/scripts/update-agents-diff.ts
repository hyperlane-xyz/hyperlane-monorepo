import { ChainName } from '@abacus-network/sdk';

import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const networks = Object.keys(config.transactionConfigs) as ChainName[];
  for (const network of networks) {
    await runAgentHelmCommand(
      HelmCommand.UpgradeDiff,
      config.agent,
      network,
      networks,
    );
  }
}

deploy().then(console.log).catch(console.error);
