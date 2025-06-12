import { ethers } from 'ethers';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  DerivedWarpRouteDeployConfig,
  EvmERC20WarpRouteReader,
  HypTokenRouterConfig,
  MultiProvider,
  StarknetERC20WarpRouteReader,
  TokenStandard,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

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
  }>,
  warpCoreConfig?: WarpCoreConfig,
): Promise<DerivedWarpRouteDeployConfig> {
  const { multiProvider, multiProtocolProvider } = context;

  validateCompatibility(context, Object.keys(addresses));

  // Get XERC20 limits if warpCoreConfig is available
  if (warpCoreConfig) {
    await logXerc20Limits(warpCoreConfig, multiProvider);
  }

  // Derive and return warp route config
  return promiseObjAll(
    objMap(addresses, async (chain, { address }) => {
      const protocol = context.chainMetadata[chain].protocol;
      switch (protocol) {
        case ProtocolType.Ethereum: {
          return new EvmERC20WarpRouteReader(
            multiProvider,
            chain,
          ).deriveWarpRouteConfig(address);
        }
        case ProtocolType.Starknet: {
          assert(multiProtocolProvider, 'Multi Protocol Provider not defined');
          return new StarknetERC20WarpRouteReader(
            multiProtocolProvider,
            chain,
          ).deriveWarpRouteConfig(address);
        }
        default:
          logRed(`protocol type ${protocol} not supported`);
          process.exit(1);
      }
    }),
  );
}

// Validate that all chains are EVM or Starknet compatible
function validateCompatibility(
  { chainMetadata }: CommandContext,
  chains: ChainName[],
): void {
  const supportedProtocols = [ProtocolType.Ethereum, ProtocolType.Starknet];

  const nonCompatibleChains = chains
    .filter((chain) => {
      const protocol = chainMetadata[chain].protocol;
      return !supportedProtocols.includes(protocol);
    })
    .map(([chain]) => chain);

  if (nonCompatibleChains.length > 0) {
    const chainList = nonCompatibleChains.join(', ');
    const verb = nonCompatibleChains.length > 1 ? 'are' : 'is';
    logRed(
      `${chainList} ${verb} non-EVM/Starknet and not compatible with the cli`,
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
