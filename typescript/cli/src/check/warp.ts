import { warpConfigToWarpAddresses } from '@hyperlane-xyz/registry';
import {
  EvmERC20WarpModule,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  attachContractsMapAndGetForeignDeployments,
  hypERC20factories,
  proxiedFactories,
} from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logRed } from '../logger.js';
import { ViolationDiff, diffObjMerge } from '../utils/output.js';

export async function runWarpRouteCheck({
  context,
  warpRouteConfig,
  warpCoreConfig,
}: {
  context: CommandContext;
  warpRouteConfig: WarpRouteDeployConfig;
  warpCoreConfig: WarpCoreConfig;
}): Promise<[ViolationDiff, boolean]> {
  const warpAddressesByChain = warpConfigToWarpAddresses(warpCoreConfig);
  const { foreignDeployments } = attachContractsMapAndGetForeignDeployments(
    warpAddressesByChain,
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

  const warpCoreConfigByChain = Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [token.chainName, token]),
  );

  const onChainWarpConfig = await promiseObjAll(
    objMap(warpRouteConfig, async (chain, config) => {
      return new EvmERC20WarpModule(context.multiProvider, {
        config,
        chain,
        addresses: {
          deployedTokenRoute: warpCoreConfigByChain[chain].addressOrDenom!,
        },
      }).read();
    }),
  );

  // Go through each chain and only add to the output the chains that have mismatches
  const violationsByChain = Object.keys(warpRouteConfig).reduce(
    (acc, chain) => {
      const [merged, isInvalid] = diffObjMerge(
        onChainWarpConfig[chain],
        warpRouteConfig[chain],
      );

      if (isInvalid) {
        acc[0][chain] = merged;
        acc[1] ||= isInvalid;
      }

      return acc;
    },
    [{}, false] as [{ [index: string]: ViolationDiff }, boolean],
  );

  return violationsByChain;
}
