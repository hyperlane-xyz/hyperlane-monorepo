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
    cronjob: {
      schedule: kathyConfig.cronSchedule,
    },
    abacus: {
      runEnv: kathyConfig.runEnv,
      chains: coreConfig.agent.chainNames.filter(
        (chainName) => !kathyConfig.chainsToSkip?.includes(chainName),
      ),
    },
    image: {
      repository: kathyConfig.docker.repo,
      tag: kathyConfig.docker.tag,
    },
  };

  return helmifyValues(values);
}
