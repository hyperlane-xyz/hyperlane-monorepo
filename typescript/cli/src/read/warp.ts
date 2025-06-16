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
  DerivedWarpRouteDeployConfig,
  EvmERC20WarpRouteReader,
  HypTokenRouterConfig,
  MultiProvider,
  TOKEN_STANDARD_TO_PROTOCOL,
  TokenStandard,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logGray, logRed, logTable } from '../logger.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

export async function runWarpRouteRead({
  context,
  chain,
  address,
  symbol,
  standard,
}: {
  context: CommandContext;
  chain?: ChainName;
  address?: string;
  symbol?: string;
  standard?: TokenStandard;
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
        warpCoreConfig.tokens.map((t) => [
          t.chainName,
          {
            address: t.addressOrDenom!,
            standard: t.standard,
          },
        ]),
      )
    : {
        [chain!]: {
          address: address!,
          standard: standard!,
        },
      };

  return deriveWarpRouteConfigs(context, addresses, warpCoreConfig);
}

export async function getWarpRouteConfigsByCore({
  context,
  warpCoreConfig,
}: {
  context: CommandContext;
  warpCoreConfig: WarpCoreConfig;
}): Promise<DerivedWarpRouteDeployConfig> {
  const addresses = Object.fromEntries(
    warpCoreConfig.tokens.map((t) => [
      t.chainName,
      {
        address: t.addressOrDenom!,
        standard: t.standard,
      },
    ]),
  );

  return deriveWarpRouteConfigs(context, addresses, warpCoreConfig);
}

async function deriveWarpRouteConfigs(
  context: CommandContext,
  addresses: ChainMap<{
    address: string;
    standard: TokenStandard;
  }>,
  warpCoreConfig?: WarpCoreConfig,
): Promise<DerivedWarpRouteDeployConfig> {
  const { multiProvider } = context;

  validateCompatibility(addresses);

  // Get XERC20 limits if warpCoreConfig is available
  if (warpCoreConfig) {
    await logXerc20Limits(warpCoreConfig, multiProvider);
  }

  // Derive and return warp route config
  return promiseObjAll(
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
}

// Validate that all chains are EVM or Cosmos Native compatible
// by token standard
function validateCompatibility(
  addresses: ChainMap<{
    address: string;
    standard: TokenStandard;
  }>,
): void {
  const nonCompatibleChains = Object.entries(addresses)
    .filter(([_, { standard }]) => {
      const protocol = TOKEN_STANDARD_TO_PROTOCOL[standard];
      return (
        protocol !== ProtocolType.Ethereum &&
        protocol !== ProtocolType.CosmosNative
      );
    })
    .map(([chain]) => chain);

  if (nonCompatibleChains.length > 0) {
    const chainList = nonCompatibleChains.join(', ');
    logRed(
      `${chainList} ${
        nonCompatibleChains.length > 1 ? 'are' : 'is'
      } non-EVM/Cosmos and not compatible with the cli`,
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
