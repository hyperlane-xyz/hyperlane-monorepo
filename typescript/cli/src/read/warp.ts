import { ethers } from 'ethers';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import { AltVMWarpRouteReader } from '@hyperlane-xyz/deploy-sdk';
import { hasProtocol } from '@hyperlane-xyz/provider-sdk';
import {
  ChainMap,
  ChainName,
  DerivedWarpRouteDeployConfig,
  EvmERC20WarpRouteReader,
  HypTokenRouterConfig,
  MultiProvider,
  TokenStandard,
  WarpCoreConfig,
  altVmChainLookup,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  mustGet,
  objFilter,
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
  warpRouteId,
  warpCoreConfigPath,
}: {
  context: CommandContext;
  chain?: ChainName;
  address?: string;
  symbol?: string;
  warpRouteId?: string;
  warpCoreConfigPath?: string;
}): Promise<ChainMap<HypTokenRouterConfig>> {
  let addresses: ChainMap<Address>;
  let warpCoreConfig: WarpCoreConfig | undefined;
  if (symbol || warpCoreConfigPath || warpRouteId) {
    warpCoreConfig = await getWarpCoreConfigOrExit({
      context,
      symbol,
      warp: warpCoreConfigPath,
      warpRouteId,
    });

    addresses = Object.fromEntries(
      warpCoreConfig.tokens.map((t) => [t.chainName, t.addressOrDenom!]),
    );
  } else if (chain && address) {
    addresses = {
      [chain]: address,
    };
  } else {
    throw new Error(
      'Invalid input parameters. Please provide either a token symbol, a warp route id or both chain name and token address',
    );
  }

  // Remove any unsupported chain to avoid crashing
  const filteredAddresses = objFilter(
    addresses,
    (chain, _address): _address is string =>
      context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum ||
      hasProtocol(context.multiProvider.getProtocol(chain)),
  );
  if (warpCoreConfig) {
    warpCoreConfig.tokens = warpCoreConfig.tokens.filter(
      (config) =>
        context.multiProvider.getProtocol(config.chainName) ===
          ProtocolType.Ethereum ||
        hasProtocol(context.multiProvider.getProtocol(config.chainName)),
    );
  }

  return deriveWarpRouteConfigs(context, filteredAddresses, warpCoreConfig);
}

export async function getWarpRouteConfigsByCore({
  context,
  warpCoreConfig,
}: {
  context: CommandContext;
  warpCoreConfig: WarpCoreConfig;
}): Promise<DerivedWarpRouteDeployConfig> {
  const addresses = Object.fromEntries(
    warpCoreConfig.tokens.map((t) => [t.chainName, t.addressOrDenom!]),
  );

  return deriveWarpRouteConfigs(context, addresses, warpCoreConfig);
}

async function deriveWarpRouteConfigs(
  context: CommandContext,
  addresses: ChainMap<string>,
  warpCoreConfig?: WarpCoreConfig,
): Promise<DerivedWarpRouteDeployConfig> {
  const { multiProvider } = context;

  validateCompatibility(
    context.multiProvider,
    context.supportedProtocols,
    addresses,
  );

  // Get XERC20 limits if warpCoreConfig is available
  if (warpCoreConfig) {
    await logXerc20Limits(warpCoreConfig, multiProvider);
  }

  // Derive and return warp route config
  return promiseObjAll(
    objMap(addresses, async (chain, address) => {
      const protocol = context.multiProvider.getProtocol(chain);
      switch (protocol) {
        case ProtocolType.Ethereum: {
          return new EvmERC20WarpRouteReader(
            multiProvider,
            chain,
          ).deriveWarpRouteConfig(address);
        }
        default: {
          const provider = mustGet(context.altVmProviders, chain);
          return new AltVMWarpRouteReader(
            altVmChainLookup(multiProvider),
            provider,
          ).deriveWarpRouteConfig(address);
        }
      }
    }),
  );
}

// Validate that all chains are EVM or AltVM compatible
// by token standard
function validateCompatibility(
  multiProvider: MultiProvider,
  supportedProtocols: ProtocolType[],
  addresses: ChainMap<string>,
): void {
  const nonCompatibleChains = Object.entries(addresses)
    .filter(
      ([chain]) =>
        !supportedProtocols.includes(multiProvider.getProtocol(chain)),
    )
    .map(([chain]) => chain);

  if (nonCompatibleChains.length > 0) {
    const chainList = nonCompatibleChains.join(', ');
    logRed(
      `${chainList} ${
        nonCompatibleChains.length > 1 ? 'are' : 'is'
      } not compatible with the cli, compatible protocols are: ${supportedProtocols.join(', ')}`,
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
