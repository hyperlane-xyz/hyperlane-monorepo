import { ChainName } from '@abacus-network/sdk';

import { AgentConfig } from '../config';
import { HelloWorldKathyConfig } from '../config/helloworld';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { execCmd } from '../utils/utils';

export function runHelloworldKathyHelmCommand<Chain extends ChainName>(
  helmCommand: HelmCommand,
  agentConfig: AgentConfig<Chain>,
  kathyConfig: HelloWorldKathyConfig<Chain>,
) {
  const values = getHelloworldKathyHelmValues(agentConfig, kathyConfig);

  return execCmd(
    `helm ${helmCommand} helloworld-kathy ./helm/helloworld-kathy --namespace ${
      kathyConfig.namespace
    } ${values.join(' ')}`,
  );
}

function getHelloworldKathyHelmValues<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  kathyConfig: HelloWorldKathyConfig<Chain>,
) {
  const values = {
    chainsToSkip: kathyConfig.chainsToSkip,
    fullCycleTime: kathyConfig.fullCycleTime,
    messageSendTimeout: kathyConfig.messageSendTimeout,
    messageReceiptTimeout: kathyConfig.messageReceiptTimeout,
    maxSendRetries: kathyConfig.maxSendRetries,
    abacus: {
      runEnv: kathyConfig.runEnv,
      // This is just used for fetching secrets, and is not actually
      // the list of chains that kathy will send to. Because Kathy
      // will fetch secrets for all chains, regardless of skipping them or
      // not, we pass in all chains
      chains: agentConfig.contextChainNames,
    },
    image: {
      repository: kathyConfig.docker.repo,
      tag: kathyConfig.docker.tag,
    },
  };

  return helmifyValues(values);
}
