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
  const releaseName = getHelmReleaseName(configFilePath);
  return execCmd(
    `helm ${helmCommand} ${releaseName} ./helm/warp-routes --namespace ${runEnv} ${values.join(
      ' ',
    )} --set fullnameOverride="${releaseName}"`,
  );
}

function getHelmReleaseName(route: string): string {
  const match = route.match(/\/([^/]+)-deployments\.yaml$/);
  const name = match ? match[1] : route;
  return `hyperlane-warp-route-${name.toLowerCase()}`; // helm requires lower case release names
}

function getWarpRoutesHelmValues(configFilePath: string) {
  const values = {
    image: {
      repository: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '4a8f20f-20240207-232324',
    },
    configFilePath: configFilePath,
  };
  return helmifyValues(values);
}
