import { ChainName } from '@abacus-network/sdk';

import { HelloWorldKathyConfig } from './config/helloworld';
import { HelmCommand, helmifyValues } from './utils/helm';
import { execCmd } from './utils/utils';

export function runHelloworldKathyHelmCommand<Chain extends ChainName>(
  helmCommand: HelmCommand,
  kathyConfig: HelloWorldKathyConfig<Chain>,
) {
  const values = getHelloworldKathyHelmValues(kathyConfig);

  return execCmd(
    `helm ${helmCommand} helloworld-kathy ./helm/helloworld-kathy --namespace ${
      kathyConfig.namespace
    } ${values.join(' ')}`,
  );
}

function getHelloworldKathyHelmValues<Chain extends ChainName>(
  kathyConfig: HelloWorldKathyConfig<Chain>,
) {
  const values = {
    abacus: {
      runEnv: kathyConfig.runEnv,
      chains: kathyConfig.chains,
    },
    image: {
      repository: kathyConfig.docker.repo,
      tag: kathyConfig.docker.tag,
    },
  };

  return helmifyValues(values);
}
