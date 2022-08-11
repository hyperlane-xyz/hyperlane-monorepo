import { ChainName } from '@abacus-network/sdk';

import { AgentAwsUser } from '../agents/aws';
import { KEY_ROLE_ENUM } from '../agents/roles';
import { AgentConfig } from '../config';
import { HelloWorldKathyConfig } from '../config/helloworld';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { execCmd } from '../utils/utils';

export async function runHelloworldKathyHelmCommand<Chain extends ChainName>(
  helmCommand: HelmCommand,
  agentConfig: AgentConfig<Chain>,
  kathyConfig: HelloWorldKathyConfig<Chain>,
) {
  // If using AWS keys, ensure the Kathy user and key has been created
  if (agentConfig.aws) {
    const awsUser = new AgentAwsUser<Chain>(
      agentConfig.environment,
      agentConfig.context,
      KEY_ROLE_ENUM.Kathy,
      agentConfig.aws.region,
    );
    await awsUser.createIfNotExists();
    await awsUser.createKeyIfNotExists(agentConfig);
  }

  const values = getHelloworldKathyHelmValues(agentConfig, kathyConfig);

  return execCmd(
    `helm ${helmCommand} helloworld-kathy-${
      agentConfig.context
    } ./helm/helloworld-kathy --namespace ${
      kathyConfig.namespace
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

function getHelloworldKathyHelmValues<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  kathyConfig: HelloWorldKathyConfig<Chain>,
) {
  const values = {
    abacus: {
      runEnv: kathyConfig.runEnv,
      context: agentConfig.context,
      // This is just used for fetching secrets, and is not actually
      // the list of chains that kathy will send to. Because Kathy
      // will fetch secrets for all chains, regardless of skipping them or
      // not, we pass in all chains
      chains: agentConfig.contextChainNames,
      aws: agentConfig.aws !== undefined,

      chainsToSkip: kathyConfig.chainsToSkip,
      fullCycleTime: kathyConfig.fullCycleTime ?? '',
      messageSendTimeout: kathyConfig.messageSendTimeout ?? '',
      messageReceiptTimeout: kathyConfig.messageReceiptTimeout ?? '',
      cycleOnce: kathyConfig.cycleOnce,
    },
    image: {
      repository: kathyConfig.docker.repo,
      tag: kathyConfig.docker.tag,
    },
  };

  return helmifyValues(values);
}
