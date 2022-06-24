import { ChainName } from '@abacus-network/sdk';

import { getHelloWorldConfig } from '../scripts/helloworld/utils';

import { CoreEnvironmentConfig } from './config';
import { HelloWorldKathyConfig } from './config/helloworld';
import { HelmCommand, helmifyValues } from './utils/helm';
import { execCmd } from './utils/utils';

export function runHelloworldKathyHelmCommand<Chain extends ChainName>(
  helmCommand: HelmCommand,
  coreConfig: CoreEnvironmentConfig<Chain>,
) {
  const kathyConfig = getHelloWorldConfig(coreConfig).kathy;
  const values = getHelloworldKathyHelmValues(coreConfig, kathyConfig);

  return execCmd(
    `helm ${helmCommand} helloworld-kathy ./helm/helloworld-kathy --namespace ${
      kathyConfig.namespace
    } ${values.join(' ')}`,
  );
}

function getHelloworldKathyHelmValues<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
  kathyConfig: HelloWorldKathyConfig<Chain>,
) {
  const values = {
    chainsToSkip: kathyConfig.chainsToSkip,
    cronjob: {
      schedule: kathyConfig.cronSchedule,
    },
    abacus: {
      runEnv: kathyConfig.runEnv,
      // This is just used for fetching secrets, and is not actually
      // the list of chains that kathy will send to. Because Kathy
      // will fetch secrets for all chains, regardless of skipping them or
      // not, we pass in all chains
      chains: coreConfig.agent.chainNames,
    },
    image: {
      repository: kathyConfig.docker.repo,
      tag: kathyConfig.docker.tag,
    },
  };

  return helmifyValues(values);
}
