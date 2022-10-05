import { doesAgentReleaseExist, runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getCoreEnvironmentConfig,
  getEnvironment,
} from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  const agentConfig = await getContextAgentConfig(config);

  await assertCorrectKubeContext(config);

  const allChains = Object.keys(config.transactionConfigs);
  await Promise.all(
    allChains
      .filter((_) => !agentConfig.contextChainNames.includes(_))
      .map(async (chainName) => {
        if (await doesAgentReleaseExist(agentConfig, chainName)) {
          runAgentHelmCommand(HelmCommand.Remove, agentConfig, chainName);
        }
      }),
  );
}

deploy().then(console.log).catch(console.error);
