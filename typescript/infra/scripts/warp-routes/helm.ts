import { HelmCommand } from '../../src/utils/helm';
import { execCmd } from '../../src/utils/utils';
import { assertCorrectKubeContext, getEnvironmentConfig } from '../utils';

export async function runWarpRouteHelmCommand(helmCommand: HelmCommand) {
  //   const values = getWarpRoutesHelmValues();
  const mainnetConfig = getEnvironmentConfig('mainnet2');
  await assertCorrectKubeContext(mainnetConfig);
  // TODO from config
  return execCmd(
    `helm ${helmCommand} ${getHelmReleaseName(
      'zebec',
    )} ./helm/warp-routes --namespace mainnet2 --set image.repository="gcr.io/abacus-labs-dev/hyperlane-monorepo" --set image.tag="c328618-20230822-230047"`,
  );
}

function getHelmReleaseName(route: string): string {
  return `helloworld-warp-route-${route}`;
}

// function getWarpRoutesHelmValues() {
//   const values = {
//     image: {
//       repository: warpRouteConfig.docker.repo,
//       tag: warpRouteConfig.docker.tag,
//     },
//   };
//   return helmifyValues(values);
// }
