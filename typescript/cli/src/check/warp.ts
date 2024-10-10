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
import { logRed } from '../logger.js';

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

  const warpAddressesByChain = warpConfigToWarpAddresses(warpCoreConfig);
  const filteredAddresses = Object.keys(warpAddressesByChain)
    .filter((key) => key in warpRouteConfig)
    .reduce((obj, key) => {
      obj[key] = {
        ...warpAddressesByChain[key],
      };

      return obj;
    }, {} as typeof warpAddressesByChain);

  const { contractsMap, foreignDeployments } =
    attachContractsMapAndGetForeignDeployments(
      filteredAddresses,
      { ...hypERC20factories, ...proxiedFactories },
      context.multiProvider,
    );

  // Check if there any non-EVM chains in the config and exit
  const nonEvmChains = Object.keys(warpAddressesByChain).filter(
    (c) => foreignDeployments[c],
  );

  if (nonEvmChains.length > 0) {
    const chainList = nonEvmChains.join(', ');
    logRed(
      `${chainList} ${
        nonEvmChains.length > 1 ? 'are' : 'is'
      } non-EVM and not compatible with warp checker tooling`,
    );
    process.exit(1);
  }

  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    chainAddresses,
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
