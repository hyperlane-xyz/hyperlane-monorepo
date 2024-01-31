import { DeployEnvironment } from '../../src/config';
import { HelmCommand, helmifyValues } from '../../src/utils/helm';
import { execCmd } from '../../src/utils/utils';
import { assertCorrectKubeContext, getEnvironmentConfig } from '../utils';

export async function runWarpRouteHelmCommand(
  helmCommand: HelmCommand,
  runEnv: DeployEnvironment,
  configFilePath: string,
) {
  const envConfig = getEnvironmentConfig(runEnv);
  await assertCorrectKubeContext(envConfig);
  const values = getWarpRoutesHelmValues(configFilePath);
  return execCmd(
    `helm ${helmCommand} ${getHelmReleaseName(
      configFilePath,
    )} ./helm/warp-routes --namespace ${runEnv} ${values.join(
      ' ',
    )} --set fullnameOverride="${getHelmReleaseName(configFilePath)}"`,
  );
}

function getHelmReleaseName(route: string): string {
  const match = route.match(/\/([^/]+)-deployments\.yaml$/);
  const name = match ? match[1] : route;
  console.log(`helm release name: hyperlane-warp-route-${name}`);
  return `hyperlane-warp-route-${name}`;
}

function getWarpRoutesHelmValues(configFilePath: string) {
  const values = {
    image: {
      repository: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: 'ae8ce44-20231101-012032',
    },
    configFilePath: configFilePath,
  };
  return helmifyValues(values);
}
