import { AgentContextConfig } from '../config/agent/agent.js';
import { EnvironmentConfig } from '../config/environment.js';
import { KeyFunderConfig } from '../config/funding.js';
import { HelmCommand, helmifyValues } from '../utils/helm.js';
import { execCmd } from '../utils/utils.js';

export async function runKeyFunderHelmCommand(
  helmCommand: HelmCommand,
  agentConfig: AgentContextConfig,
  keyFunderConfig: KeyFunderConfig,
) {
  const values = getKeyFunderHelmValues(agentConfig, keyFunderConfig);
  if (helmCommand === HelmCommand.InstallOrUpgrade) {
    // Delete secrets to avoid them being stale
    try {
      await execCmd(
        `kubectl delete secrets --namespace ${agentConfig.namespace} --selector app.kubernetes.io/instance=key-funder`,
        {},
        false,
        false,
      );
    } catch (e) {
      console.error(e);
    }
  }

  return execCmd(
    `helm ${helmCommand} key-funder ./helm/key-funder --namespace ${
      keyFunderConfig.namespace
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

function getKeyFunderHelmValues(
  agentConfig: AgentContextConfig,
  keyFunderConfig: KeyFunderConfig,
) {
  const values = {
    cronjob: {
      schedule: keyFunderConfig.cronSchedule,
    },
    hyperlane: {
      runEnv: agentConfig.runEnv,
      // Only used for fetching RPC urls as env vars
      chains: agentConfig.environmentChainNames,
      contextFundingFrom: keyFunderConfig.contextFundingFrom,
      contextsAndRolesToFund: keyFunderConfig.contextsAndRolesToFund,
      connectionType: keyFunderConfig.connectionType,
      desiredBalancePerChain: keyFunderConfig.desiredBalancePerChain,
      desiredKathyBalancePerChain: keyFunderConfig.desiredKathyBalancePerChain,
    },
    image: {
      repository: keyFunderConfig.docker.repo,
      tag: keyFunderConfig.docker.tag,
    },
    infra: {
      prometheusPushGateway: keyFunderConfig.prometheusPushGateway,
    },
  };
  return helmifyValues(values);
}

export function getKeyFunderConfig(
  coreConfig: EnvironmentConfig,
): KeyFunderConfig {
  const keyFunderConfig = coreConfig.keyFunderConfig;
  if (!keyFunderConfig) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a KeyFunderConfig config`,
    );
  }
  return keyFunderConfig;
}
