import { ChainMap, MultiProvider, RouterConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts';
import { routingIsm } from '../../../config/routingIsm';
import { getRouterConfig } from '../../../scripts/utils';
import { DeployEnvironment } from '../environment';

export async function helloWorldRouterConfig(
  environment: DeployEnvironment,
  context: Contexts,
  multiProvider: MultiProvider,
): Promise<ChainMap<RouterConfig>> {
  const routerConfig = await getRouterConfig(environment, multiProvider, true);
  return objMap(routerConfig, (chain, config) => ({
    ...config,
    interchainSecurityModule: routingIsm(environment, chain, context),
  }));
}
