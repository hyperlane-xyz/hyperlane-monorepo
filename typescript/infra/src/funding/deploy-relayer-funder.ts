import { ChainName } from '@abacus-network/sdk';

import { CoreEnvironmentConfig } from '../config';
import { RelayerFunderConfig } from '../config/funding';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { execCmd } from '../utils/utils';

export function runRelayerFunderHelmCommand<Chain extends ChainName>(
  helmCommand: HelmCommand,
  coreConfig: CoreEnvironmentConfig<Chain>,
) {
  const relayerFunderConfig = getRelayerFunderConfig(coreConfig);
  const values = getRelayerFunderHelmValues(coreConfig, relayerFunderConfig);

  return execCmd(
    `helm ${helmCommand} relayer-funder ./helm/relayer-funder --namespace ${
      relayerFunderConfig.namespace
    } ${values.join(' ')}`,
  );
}

function getRelayerFunderHelmValues<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
  relayerFunderConfig: RelayerFunderConfig,
) {
  const values = {
    cronjob: {
      schedule: relayerFunderConfig.cronSchedule,
    },
    abacus: {
      runEnv: coreConfig.environment,
      chains: coreConfig.agent.chainNames,
    },
    image: {
      repository: relayerFunderConfig.docker.repo,
      tag: relayerFunderConfig.docker.tag,
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
