import { ChainMap, MultiProvider, RouterConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { routingIsm } from '../../config/routingIsm';
import { getRouterConfig } from '../../scripts/utils';

import { DeployEnvironment } from './environment';
import { HelloWorldConfig } from './helloworld';

export const helloWorldConfig = (
  environment: DeployEnvironment,
  context: Contexts,
  configMap: ChainMap<HelloWorldConfig>,
): ChainMap<HelloWorldConfig> =>
  objMap(configMap, (chain, config) => ({
    ...config,
    interchainSecurityModule:
      context === Contexts.Hyperlane
        ? undefined
        : routingIsm(environment, chain, context),
  }));

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
        ? undefined
        : routingIsm(environment, chain.toString(), context),
  }));
}
