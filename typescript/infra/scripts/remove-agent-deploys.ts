import { doesAgentReleaseExist, runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironment,
  getEnvironmentConfig,
} from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = getEnvironmentConfig(environment);

  const agentConfig = await getContextAgentConfig(config);

  await assertCorrectKubeContext(config);

  const allChains = Object.keys(config.chainMetadataConfigs);
  await Promise.all(
    allChains
      .filter((_) => !agentConfig.contextChainNames.includes(_))
      .map(async (chainName) => {
        if (await doesAgentReleaseExist(agentConfig, chainName)) {
          await runAgentHelmCommand(HelmCommand.Remove, agentConfig, chainName);
        }
      }),
  );
}

deploy().then(console.log).catch(console.error);
