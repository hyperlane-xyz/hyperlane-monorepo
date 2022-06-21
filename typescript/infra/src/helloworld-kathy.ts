import { ChainName } from '@abacus-network/sdk';

import { AgentConfig } from './config';
import { HelmCommand, helmifyValues } from './utils/helm';
import { execCmd } from './utils/utils';

export function runHelloworldKathyHelmCommand<Chain extends ChainName>(
  helmCommand: HelmCommand,
  agentConfig: AgentConfig<Chain>,
) {
  const values = getHelloworldKathyHelmValues(agentConfig);

  return execCmd(
    `helm ${helmCommand} helloworld-kathy ./helm/helloworld-kathy --namespace ${
      agentConfig.namespace
    } ${values.join(' ')}`,
  );
}

function getHelloworldKathyHelmValues<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
) {
  const values = {
    abacus: {
      runEnv: agentConfig.runEnv,
      chains: agentConfig.chainNames,
    },
  };

  return helmifyValues(values);
}
