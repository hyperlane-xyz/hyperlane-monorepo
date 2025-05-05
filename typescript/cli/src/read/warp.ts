import { ethers } from 'ethers';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CosmosNativeWarpRouteReader,
  EvmERC20WarpRouteReader,
  HypTokenRouterConfig,
  TOKEN_STANDARD_TO_PROTOCOL,
  TokenStandard,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logGray, logRed, logTable } from '../logger.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

export async function runWarpRouteRead({
  context,
  chain,
  address,
  warp,
  symbol,
  standard,
}: {
  context: CommandContext;
  chain?: ChainName;
  warp?: string;
  address?: string;
  symbol?: string;
  standard?: TokenStandard;
}): Promise<Record<ChainName, HypTokenRouterConfig>> {
  const { multiProvider } = context;

  let addresses: ChainMap<{
    address: string;
    standard: TokenStandard;
  }>;

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
      warpCoreConfig.tokens.map((t) => [
        t.chainName,
        {
          address: t.addressOrDenom!,
          standard: t.standard,
        },
      ]),
    );
  } else if (chain && address && standard) {
    addresses = {
      [chain]: {
        address,
        standard,
      },
    };
  } else {
    logRed(`Please specify either a symbol, chain and address or warp file`);
    process.exit(1);
  }

  const config = await promiseObjAll(
    objMap(addresses, async (chain, { address, standard }) => {
      switch (TOKEN_STANDARD_TO_PROTOCOL[standard]) {
        case ProtocolType.Ethereum: {
          return new EvmERC20WarpRouteReader(
            multiProvider,
            chain,
          ).deriveWarpRouteConfig(address);
        }
        case ProtocolType.CosmosNative: {
          const cosmosProvider =
            await context.multiProtocolProvider!.getCosmJsNativeProvider(chain);
          return new CosmosNativeWarpRouteReader(
            multiProvider,
            chain,
            cosmosProvider,
          ).deriveWarpRouteConfig(address);
        }
        default:
          logRed(`token standard ${standard} not supported`);
          process.exit(1);
      }
    }),
  );

  return config;
}
