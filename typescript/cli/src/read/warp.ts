import { ethers } from 'ethers';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  DerivedTokenRouterConfig,
  EvmERC20WarpRouteReader,
  TokenStandard,
} from '@hyperlane-xyz/sdk';
import { isAddressEvm, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logGray, logRed, logTable } from '../logger.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

export async function runWarpRouteRead({
  context,
  chain,
  address,
  warp,
  symbol,
}: {
  context: CommandContext;
  chain?: ChainName;
  warp?: string;
  address?: string;
  symbol?: string;
}): Promise<Record<ChainName, DerivedTokenRouterConfig>> {
  const { multiProvider } = context;

  let addresses: ChainMap<string>;
  if (symbol || warp) {
    const warpCoreConfig =
      context.warpCoreConfig ?? // this case is be handled by MultiChainHandler.forWarpCoreConfig() interceptor
      (await getWarpCoreConfigOrExit({
        context,
        warp,
        symbol,
      }));

    // TODO: merge with XERC20TokenAdapter and WarpRouteReader
    const xerc20Limits = await Promise.all(
      warpCoreConfig.tokens
        .filter(
          (t) =>
            t.standard === TokenStandard.EvmHypXERC20 ||
            t.standard === TokenStandard.EvmHypXERC20Lockbox,
        )
        .map(async (t) => {
          const provider = multiProvider.getProvider(t.chainName);
          const router = t.addressOrDenom!;
          const xerc20Address =
            t.standard === TokenStandard.EvmHypXERC20Lockbox
              ? await HypXERC20Lockbox__factory.connect(
                  router,
                  provider,
                ).xERC20()
              : await HypXERC20__factory.connect(
                  router,
                  provider,
                ).wrappedToken();

          const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
          const mint = await xerc20.mintingCurrentLimitOf(router);
          const burn = await xerc20.burningCurrentLimitOf(router);

          const formattedLimits = objMap({ mint, burn }, (_, v) =>
            ethers.utils.formatUnits(v, t.decimals),
          );

          return [t.chainName, formattedLimits];
        }),
    );

    if (xerc20Limits.length > 0) {
      logGray('xERC20 Limits:');
      logTable(Object.fromEntries(xerc20Limits));
    }

    addresses = Object.fromEntries(
      warpCoreConfig.tokens.map((t) => [t.chainName, t.addressOrDenom!]),
    );
  } else if (chain && address) {
    addresses = {
      [chain]: address,
    };
  } else {
    logRed(`Please specify either a symbol, chain and address or warp file`);
    process.exit(1);
  }

  // Check if there any non-EVM chains in the config and exit
  const nonEvmChains = Object.entries(addresses)
    .filter(([_, address]) => !isAddressEvm(address))
    .map(([chain]) => chain);
  if (nonEvmChains.length > 0) {
    const chainList = nonEvmChains.join(', ');
    logRed(
      `${chainList} ${
        nonEvmChains.length > 1 ? 'are' : 'is'
      } non-EVM and not compatible with the cli`,
    );
    process.exit(1);
  }

  const config = await promiseObjAll(
    objMap(addresses, async (chain, address) =>
      new EvmERC20WarpRouteReader(multiProvider, chain).deriveWarpRouteConfig(
        address,
      ),
    ),
  );

  return config;
}
