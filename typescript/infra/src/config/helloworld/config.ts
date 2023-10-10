import { ChainMap } from '@hyperlane-xyz/sdk';
import { MultiProvider, RouterConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts';
import {
  mainnetHyperlaneDefaultIsmCache,
  routingIsm,
} from '../../../config/routingIsm';
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
    interchainSecurityModule:
      context === Contexts.Hyperlane
        ? // TODO move back to `undefined` after these are verified and made the default ISMs
          mainnetHyperlaneDefaultIsmCache[chain]
        : routingIsm(environment, chain, context),
  }));
}
