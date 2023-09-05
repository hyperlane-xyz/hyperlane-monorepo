import { DeployEnvironment } from '../../src/config';
import { HelmCommand, helmifyValues } from '../../src/utils/helm';
import { execCmd } from '../../src/utils/utils';
import { assertCorrectKubeContext, getEnvironmentConfig } from '../utils';

export async function runWarpRouteHelmCommand(
  helmCommand: HelmCommand,
  runEnv: DeployEnvironment,
) {
  const envConfig = getEnvironmentConfig(runEnv);
  await assertCorrectKubeContext(envConfig);
  const values = getWarpRoutesHelmValues();

  return execCmd(
    `helm ${helmCommand} ${getHelmReleaseName(
      'zebec',
    )} ./helm/warp-routes --namespace ${runEnv} ${values.join(
      ' ',
    )} --set fullnameOverride="${getHelmReleaseName('zebec')}"`,
  );
}

function getHelmReleaseName(route: string): string {
  return `hyperlane-warp-route-${route}`;
}

function getWarpRoutesHelmValues() {
  const values = {
    image: {
      repository: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '962d34b-20230905-194531',
    },
  };
  return helmifyValues(values);
}
