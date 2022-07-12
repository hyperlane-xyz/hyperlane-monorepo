import { ChainName } from '@abacus-network/sdk';

import { AgentConfig, CoreEnvironmentConfig } from '../config';
import { RelayerFunderConfig } from '../config/funding';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { execCmd } from '../utils/utils';

export function runRelayerFunderHelmCommand<Chain extends ChainName>(
  helmCommand: HelmCommand,
  agentConfig: AgentConfig<Chain>,
  relayerFunderConfig: RelayerFunderConfig,
) {
  const values = getRelayerFunderHelmValues(agentConfig, relayerFunderConfig);

  return execCmd(
    `helm ${helmCommand} relayer-funder ./helm/relayer-funder --namespace ${
      relayerFunderConfig.namespace
    } ${values.join(' ')}`,
  );
}

function getRelayerFunderHelmValues<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  relayerFunderConfig: RelayerFunderConfig,
) {
  const values = {
    cronjob: {
      schedule: relayerFunderConfig.cronSchedule,
    },
    abacus: {
      runEnv: agentConfig.environment,
      chains: agentConfig.contextChainNames,
    },
    image: {
      repository: relayerFunderConfig.docker.repo,
      tag: relayerFunderConfig.docker.tag,
    },
    infra: {
      prometheusPushGateway: relayerFunderConfig.prometheusPushGateway,
    },
  };
  return helmifyValues(values);
}

export function getRelayerFunderConfig(
  coreConfig: CoreEnvironmentConfig<any>,
): RelayerFunderConfig {
  const relayerFunderConfig = coreConfig.relayerFunderConfig;
  if (!relayerFunderConfig) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a RelayerFunderConfig config`,
    );
  }
  return relayerFunderConfig;
}
