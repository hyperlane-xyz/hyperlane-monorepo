import { Contexts } from '../../config/contexts.js';
import { AgentAwsUser } from '../agents/aws/user.js';
import { AgentGCPKey } from '../agents/gcp.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import {
  HelloWorldKathyConfig,
  HelloWorldKathyRunMode,
} from '../config/helloworld/types.js';
import { Role } from '../roles.js';
import { HelmCommand, helmifyValues } from '../utils/helm.js';
import { execCmd } from '../utils/utils.js';

export async function runHelloworldKathyHelmCommand(
  helmCommand: HelmCommand,
  agentConfig: AgentContextConfig,
  kathyConfig: HelloWorldKathyConfig,
) {
  // If using AWS keys, ensure the Kathy user and key has been created
  if (agentConfig.aws) {
    const awsUser = new AgentAwsUser(
      agentConfig.runEnv,
      agentConfig.context,
      Role.Kathy,
      agentConfig.aws.region,
    );
    await awsUser.createIfNotExists();
    await awsUser.createKeyIfNotExists(agentConfig);
  }

  // Also ensure a GCP key exists, which is used for non-EVM chains even if
  // the agent config is AWS-based
  const kathyKey = new AgentGCPKey(
    agentConfig.runEnv,
    agentConfig.context,
    Role.Kathy,
  );
  await kathyKey.createIfNotExists();

  const values = getHelloworldKathyHelmValues(agentConfig, kathyConfig);

  return execCmd(
    `helm ${helmCommand} ${getHelmReleaseName(
      agentConfig.context,
    )} ./helm/helloworld-kathy --namespace ${
      kathyConfig.namespace
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

function getHelmReleaseName(context: Contexts): string {
  // For backward compatibility, keep the hyperlane context release name as
  // 'helloworld-kathy', and add `-${context}` as a suffix for any other contexts
  return `helloworld-kathy${
    context === Contexts.Hyperlane ? '' : `-${context}`
  }`;
}

function getHelloworldKathyHelmValues(
  agentConfig: AgentContextConfig,
  kathyConfig: HelloWorldKathyConfig,
) {
  const cycleOnce =
    kathyConfig.runConfig.mode === HelloWorldKathyRunMode.CycleOnce;
  const fullCycleTime =
    kathyConfig.runConfig.mode === HelloWorldKathyRunMode.Service
      ? kathyConfig.runConfig.fullCycleTime
      : '';

  const values = {
    hyperlane: {
      runEnv: kathyConfig.runEnv,
      context: agentConfig.context,
      // This is just used for fetching secrets, and is not actually
      // the list of chains that kathy will send to. Because Kathy
      // will fetch secrets for all chains in the environment, regardless
      // of skipping them or not, we pass in all chains
      chains: agentConfig.environmentChainNames,
      aws: agentConfig.aws !== undefined,

      chainsToSkip: kathyConfig.chainsToSkip,
      messageSendTimeout: kathyConfig.messageSendTimeout,
      messageReceiptTimeout: kathyConfig.messageReceiptTimeout,
      cycleOnce,
      fullCycleTime,
      connectionType: kathyConfig.connectionType,
      cyclesBetweenEthereumMessages: kathyConfig.cyclesBetweenEthereumMessages,
    },
    image: {
      repository: kathyConfig.docker.repo,
      tag: kathyConfig.docker.tag,
    },
  };

  return helmifyValues(values);
}
