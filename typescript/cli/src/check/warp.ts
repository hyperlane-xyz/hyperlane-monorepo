import { warpConfigToWarpAddresses } from '@hyperlane-xyz/registry';
import {
  CheckerViolation,
  HypERC20App,
  HypERC20Checker,
  HyperlaneIsmFactory,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  attachContractsMapAndGetForeignDeployments,
  hypERC20factories,
  proxiedFactories,
} from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';

export async function runWarpRouteCheck({
  context,
  warpRouteConfig,
  warpCoreConfig,
}: {
  context: CommandContext;
  warpRouteConfig: WarpRouteDeployConfig;
  warpCoreConfig: WarpCoreConfig;
}): Promise<Array<CheckerViolation>> {
  const chainAddresses = await context.registry.getAddresses();

  const warpAddresses = warpConfigToWarpAddresses(warpCoreConfig);
  const filteredAddresses = Object.keys(warpAddresses) // filter out changes not in config
    .filter((key) => key in warpRouteConfig)
    .reduce((obj, key) => {
      obj[key] = {
        ...warpAddresses[key],
      };

      return obj;
    }, {} as typeof warpAddresses);

  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    chainAddresses,
    context.multiProvider,
  );

  const { contractsMap, foreignDeployments } =
    attachContractsMapAndGetForeignDeployments(
      filteredAddresses,
      { ...hypERC20factories, ...proxiedFactories },
      context.multiProvider,
    );

  const app = new HypERC20App(
    contractsMap,
    context.multiProvider,
    undefined,
    foreignDeployments,
  );

  const checker = new HypERC20Checker(
    context.multiProvider,
    app,
    warpRouteConfig,
    ismFactory,
  );

  await checker.check();

  return checker.violations;
}
