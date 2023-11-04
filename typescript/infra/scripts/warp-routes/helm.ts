import { DeployEnvironment } from '../../src/config';
import { HelmCommand, helmifyValues } from '../../src/utils/helm';
import { execCmd } from '../../src/utils/utils';
import { assertCorrectKubeContext, getEnvironmentConfig } from '../utils';

export async function runWarpRouteHelmCommand(
  helmCommand: HelmCommand,
  runEnv: DeployEnvironment,
  config: string,
) {
  const envConfig = getEnvironmentConfig(runEnv);
  await assertCorrectKubeContext(envConfig);
  const values = getWarpRoutesHelmValues(config);

  return execCmd(
    `helm ${helmCommand} ${getHelmReleaseName(
      config,
    )} ./helm/warp-routes --namespace ${runEnv} ${values.join(
      ' ',
    )} --set fullnameOverride="${getHelmReleaseName(config)}"`,
  );
}

function getHelmReleaseName(route: string): string {
  return `hyperlane-warp-route-${route}`;
}

function getWarpRoutesHelmValues(config: string) {
  const values = {
    image: {
      repository: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '62afc11-20231103-223949',
    },
    config: config, // nautilus or neutron
  };
  return helmifyValues(values);
}
