import { ethers } from 'ethers';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  EvmERC20WarpRouteReader,
  HypTokenRouterConfig,
  MultiProvider,
  TokenStandard,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { isAddressEvm, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logGray, logRed, logTable } from '../logger.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

export async function runWarpRouteRead({
  context,
  chain,
  address,
  symbol,
}: {
  context: CommandContext;
  chain?: ChainName;
  address?: string;
  symbol?: string;
}): Promise<ChainMap<HypTokenRouterConfig>> {
  const hasTokenSymbol = Boolean(symbol);
  const hasChainAddress = Boolean(chain && address);

  if (!hasTokenSymbol && !hasChainAddress) {
    logRed(
      'Invalid input parameters. Please provide either a token symbol or both chain name and token address',
    );
    process.exit(1);
  }

  const warpCoreConfig = hasTokenSymbol
    ? await getWarpCoreConfigOrExit({
        context,
        symbol,
      })
    : undefined;

  const addresses = warpCoreConfig
    ? Object.fromEntries(
        warpCoreConfig.tokens.map((t) => [t.chainName, t.addressOrDenom!]),
      )
    : { [chain!]: address! };

  return deriveWarpRouteConfigs(context, addresses, warpCoreConfig);
}

export async function getWarpRouteConfigsByCore({
  context,
  warpCoreConfig,
}: {
  context: CommandContext;
  warpCoreConfig: WarpCoreConfig;
}): Promise<ChainMap<HypTokenRouterConfig>> {
  const addresses = Object.fromEntries(
    warpCoreConfig.tokens.map((t) => [t.chainName, t.addressOrDenom!]),
  );

  return deriveWarpRouteConfigs(context, addresses, warpCoreConfig);
}

async function deriveWarpRouteConfigs(
  context: CommandContext,
  addresses: ChainMap<string>,
  warpCoreConfig?: WarpCoreConfig,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const { multiProvider } = context;

  validateEvmCompatibility(addresses);

  // Get XERC20 limits if warpCoreConfig is available
  if (warpCoreConfig) {
    await logXerc20Limits(warpCoreConfig, multiProvider);
  }

  // Derive and return warp route config
  return promiseObjAll(
    objMap(addresses, async (chain, address) =>
      new EvmERC20WarpRouteReader(multiProvider, chain).deriveWarpRouteConfig(
        address,
      ),
    ),
  );
}

// Validate that all chains are EVM compatible
function validateEvmCompatibility(addresses: ChainMap<string>): void {
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
}

/**
 * Logs XERC20 token limits for the given warp core config
 */
export async function logXerc20Limits(
  warpCoreConfig: WarpCoreConfig,
  multiProvider: MultiProvider,
): Promise<void> {
  const xerc20Tokens = warpCoreConfig.tokens.filter(
    (t) =>
      t.standard === TokenStandard.EvmHypXERC20 ||
      t.standard === TokenStandard.EvmHypXERC20Lockbox,
  );

  if (xerc20Tokens.length === 0) {
    return;
  }

  // TODO: merge with XERC20TokenAdapter and WarpRouteReader
  const xerc20Limits = await Promise.all(
    xerc20Tokens.map(async (t) => {
      const provider = multiProvider.getProvider(t.chainName);
      const router = t.addressOrDenom!;
      const xerc20Address =
        t.standard === TokenStandard.EvmHypXERC20Lockbox
          ? await HypXERC20Lockbox__factory.connect(router, provider).xERC20()
          : await HypXERC20__factory.connect(router, provider).wrappedToken();

      const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
      const mint = await xerc20.mintingCurrentLimitOf(router);
      const burn = await xerc20.burningCurrentLimitOf(router);

      const formattedLimits = objMap({ mint, burn }, (_, v) =>
        ethers.utils.formatUnits(v, t.decimals),
      );

      return [t.chainName, formattedLimits];
    }),
  );

  logGray('xERC20 Limits:');
  logTable(Object.fromEntries(xerc20Limits));
}
