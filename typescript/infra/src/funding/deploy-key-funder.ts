import { ChainName } from '@hyperlane-xyz/sdk';

import { AgentConfig, CoreEnvironmentConfig } from '../config';
import { KeyFunderConfig } from '../config/funding';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { execCmd } from '../utils/utils';

export function runKeyFunderHelmCommand<Chain extends ChainName>(
  helmCommand: HelmCommand,
  agentConfig: AgentConfig<Chain>,
  keyFunderConfig: KeyFunderConfig,
) {
  const values = getKeyFunderHelmValues(agentConfig, keyFunderConfig);

  return execCmd(
    `helm ${helmCommand} key-funder ./helm/key-funder --namespace ${
      keyFunderConfig.namespace
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

function getKeyFunderHelmValues<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  keyFunderConfig: KeyFunderConfig,
) {
  const values = {
    cronjob: {
      schedule: keyFunderConfig.cronSchedule,
    },
    abacus: {
      runEnv: agentConfig.environment,
      // Only used for fetching RPC urls as env vars
      chains: agentConfig.contextChainNames,
      contextFundingFrom: keyFunderConfig.contextFundingFrom,
      contextsAndRolesToFund: keyFunderConfig.contextsAndRolesToFund,
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
  coreConfig: CoreEnvironmentConfig<any>,
): KeyFunderConfig {
  const keyFunderConfig = coreConfig.keyFunderConfig;
  if (!keyFunderConfig) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a KeyFunderConfig config`,
    );
  }
  return keyFunderConfig;
}
