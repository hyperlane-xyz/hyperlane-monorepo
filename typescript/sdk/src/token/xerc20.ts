import { ethers } from 'ethers';
import { Logger } from 'pino';
import { Log, parseEventLogs } from 'viem';

import {
  HypXERC20Lockbox__factory,
  IXERC20Lockbox__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  assert,
  normalizeAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { isContractAddress } from '../contracts/contracts.js';
import { isProxy, proxyImplementation } from '../deploy/proxy.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { viemLogFromGetEventLogsResponse } from '../rpc/evm/utils.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { throwIfNotMissingSelector } from '../utils/contract.js';
import { WarpCoreConfig } from '../warp/types.js';

import { TokenType } from './config.js';
import {
  WarpRouteDeployConfig,
  XERC20TokenExtraBridgesLimits,
  XERC20Type,
  isXERC20TokenConfig,
} from './types.js';
import {
  CONFIGURATION_CHANGED_EVENT_SELECTOR,
  XERC20_VS_ABI,
} from './xerc20-abi.js';

// Bridge config types for Velodrome (VS) and Standard (WL) XERC20
type BridgeConfigBase = {
  chain: ChainName;
  type: typeof TokenType.XERC20Lockbox | typeof TokenType.XERC20;
  xERC20Address: Address;
  bridgeAddress: Address;
  decimals: number;
  owner: Address;
};

export type BridgeConfigVS = BridgeConfigBase & {
  bufferCap: number;
  rateLimitPerSecond: number;
};

export type BridgeConfigWL = BridgeConfigBase & {
  mint: number;
  burn: number;
};

export type GetExtraLockboxesOptions = {
  chain: ChainNameOrId;
  xERC20Address: Address;
  multiProvider: MultiProvider;
  logger?: Logger;
};

// xERC20 tokens emit ConfigurationChanged rarely, so scanning them over the
// 500 block default is prohibitively slow. 1_000_000 was measured on base
// specifically, which declares no pagination.maxBlockRange: the token's full
// history was covered in 22 requests (~2.3s). Providers that cap the span
// reject the chunk, and getLogsFromRpc halves the range until it is accepted.
export const XERC20_LOG_SCAN_BLOCK_RANGE = 1_000_000;

export async function getExtraLockBoxConfigs({
  xERC20Address,
  chain,
  multiProvider,
  logger = rootLogger,
}: GetExtraLockboxesOptions): Promise<XERC20TokenExtraBridgesLimits[]> {
  const logsReader = EvmEventLogsReader.fromConfig(
    { chain, paginationBlockRange: XERC20_LOG_SCAN_BLOCK_RANGE },
    multiProvider,
    logger,
  );

  const logs = await logsReader.getLogsByTopic({
    contractAddress: xERC20Address,
    eventTopic: CONFIGURATION_CHANGED_EVENT_SELECTOR,
  });

  const viemLogs = logs.map(viemLogFromGetEventLogsResponse);
  return getLockboxesFromLogs(
    viemLogs,
    multiProvider.getProvider(chain),
    chain,
    logger,
  );
}

export type ConfigurationChangedLog = Log<
  bigint,
  number,
  false,
  undefined,
  true,
  typeof XERC20_VS_ABI,
  'ConfigurationChanged'
>;

/**
 * Parses ConfigurationChanged logs and keeps only the most recent configuration
 * of each bridge, keyed by its normalized address.
 *
 * A bridge can be reconfigured more than once in the same block, so the block
 * number alone is not a total order over the logs and logIndex breaks the tie.
 */
export function latestConfigurationPerBridge(
  logs: Log[],
): Map<Address, ConfigurationChangedLog> {
  const parsedLogs = parseEventLogs({
    abi: XERC20_VS_ABI,
    eventName: 'ConfigurationChanged',
    logs,
  });

  const latestPerBridge = new Map<Address, ConfigurationChangedLog>();
  for (const log of parsedLogs) {
    const bridge = normalizeAddress(log.args.bridge);
    const current = latestPerBridge.get(bridge);
    const isMostRecentLogForBridge =
      !current ||
      log.blockNumber > current.blockNumber ||
      (log.blockNumber === current.blockNumber &&
        log.logIndex > current.logIndex);

    if (isMostRecentLogForBridge) {
      latestPerBridge.set(bridge, log);
    }
  }

  return latestPerBridge;
}

async function getLockboxesFromLogs(
  logs: Log[],
  provider: ethers.providers.Provider,
  chain: ChainNameOrId,
  logger: Logger,
): Promise<XERC20TokenExtraBridgesLimits[]> {
  const lockboxPromises = [...latestConfigurationPerBridge(logs).entries()]
    // Removing bridges where the limits are set to 0 because it is equivalent of being deactivated
    // A bridge is active if EITHER bufferCap OR rateLimitPerSecond is non-zero
    .filter(
      ([, log]) =>
        log.args.bufferCap !== 0n || log.args.rateLimitPerSecond !== 0n,
    )
    .map(async ([bridge, log]) => {
      try {
        const maybeXERC20Lockbox = IXERC20Lockbox__factory.connect(
          bridge,
          provider,
        );

        await maybeXERC20Lockbox.callStatic.XERC20();
        return { bridge, log };
      } catch (error) {
        throwIfNotMissingSelector(error);
        logger.debug(
          `Contract at address ${bridge} on chain ${chain} is not a XERC20Lockbox contract.`,
        );
        return undefined;
      }
    });

  const lockboxes = await Promise.all(lockboxPromises);

  const extraBridges: XERC20TokenExtraBridgesLimits[] = [];
  for (const lockbox of lockboxes) {
    if (!lockbox) {
      continue;
    }

    extraBridges.push({
      lockbox: lockbox.bridge,
      limits: {
        type: XERC20Type.Velo,
        bufferCap: lockbox.log.args.bufferCap.toString(),
        rateLimitPerSecond: lockbox.log.args.rateLimitPerSecond.toString(),
      },
    });
  }

  return extraBridges;
}

/**
 * Derives bridge configurations for Velodrome XERC20 tokens.
 * Extracts bufferCap and rateLimitPerSecond limits from warp deploy config.
 * @param warpDeployConfig - Warp route deployment configuration
 * @param warpCoreConfig - Warp core configuration with token metadata
 * @param multiProvider - Multi-chain provider for contract interactions
 * @returns Array of bridge configurations for Velodrome XERC20
 */
export async function deriveBridgesConfig(
  warpDeployConfig: WarpRouteDeployConfig,
  warpCoreConfig: WarpCoreConfig,
  multiProvider: MultiProvider,
): Promise<BridgeConfigVS[]> {
  const bridgesConfig: BridgeConfigVS[] = [];

  for (const [chainName, chainConfig] of Object.entries(warpDeployConfig)) {
    if (!isXERC20TokenConfig(chainConfig)) {
      throw new Error(
        `Chain "${chainName}" is not an xERC20 compliant deployment`,
      );
    }

    const { token, type, owner, xERC20 } = chainConfig;

    const decimals = warpCoreConfig.tokens.find(
      (t) => t.chainName === chainName,
    )?.decimals;
    if (!decimals) {
      throw new Error(`Missing "decimals" for chain: ${chainName}`);
    }

    if (!xERC20 || xERC20.warpRouteLimits.type !== XERC20Type.Velo) {
      rootLogger.debug(
        `Skip deriving bridges config because ${XERC20Type.Velo} type is expected`,
      );
      continue;
    }

    if (
      !xERC20.warpRouteLimits.bufferCap ||
      !xERC20.warpRouteLimits.rateLimitPerSecond
    ) {
      throw new Error(`Missing "limits" for chain: ${chainName}`);
    }

    let xERC20Address = token;
    const bridgeAddress = warpCoreConfig.tokens.find(
      (t) => t.chainName === chainName,
    )?.addressOrDenom;
    if (!bridgeAddress) {
      throw new Error(
        `Missing router address for chain ${chainName} and type ${type}`,
      );
    }

    const {
      bufferCap: bufferCapStr,
      rateLimitPerSecond: rateLimitPerSecondStr,
    } = xERC20.warpRouteLimits;
    const bufferCap = Number(bufferCapStr);
    const rateLimitPerSecond = Number(rateLimitPerSecondStr);

    if (type === TokenType.XERC20Lockbox) {
      const provider = multiProvider.getProvider(chainName);
      const hypXERC20Lockbox = HypXERC20Lockbox__factory.connect(
        bridgeAddress,
        provider,
      );

      xERC20Address = await hypXERC20Lockbox.xERC20();
    }

    if (xERC20.extraBridges) {
      for (const extraLockboxLimit of xERC20.extraBridges) {
        const { lockbox, limits } = extraLockboxLimit;
        assert(
          limits.type === XERC20Type.Velo,
          `Only supports ${XERC20Type.Velo}`,
        );
        const {
          bufferCap: extraBufferCap,
          rateLimitPerSecond: extraRateLimit,
        } = limits;

        if (!extraBufferCap || !extraRateLimit) {
          throw new Error(
            `Missing "bufferCap" or "rateLimitPerSecond" limits for extra lockbox: ${lockbox} on chain: ${chainName}`,
          );
        }

        bridgesConfig.push({
          chain: chainName as ChainName,
          type,
          xERC20Address,
          bridgeAddress: lockbox,
          owner,
          decimals,
          bufferCap: Number(extraBufferCap),
          rateLimitPerSecond: Number(extraRateLimit),
        });
      }
    }

    bridgesConfig.push({
      chain: chainName as ChainName,
      type,
      xERC20Address,
      bridgeAddress,
      owner,
      decimals,
      bufferCap,
      rateLimitPerSecond,
    });
  }

  return bridgesConfig;
}

/**
 * Derives bridge configurations for Standard XERC20 tokens.
 * Extracts mint and burn limits from warp deploy config.
 * @param chains - Optional list of chains to filter by
 * @param warpDeployConfig - Warp route deployment configuration
 * @param warpCoreConfig - Warp core configuration with token metadata
 * @param multiProvider - Multi-chain provider for contract interactions
 * @returns Array of bridge configurations for Standard XERC20
 */
export async function deriveStandardBridgesConfig(
  chains: ChainName[] = [],
  warpDeployConfig: WarpRouteDeployConfig,
  warpCoreConfig: WarpCoreConfig,
  multiProvider: MultiProvider,
): Promise<BridgeConfigWL[]> {
  const bridgesConfig: BridgeConfigWL[] = [];

  for (const [chainName, chainConfig] of Object.entries(warpDeployConfig)) {
    if (chains.length > 0 && !chains.includes(chainName as ChainName)) {
      rootLogger.debug(
        `Skipping ${chainName} because its not included in chains`,
      );
      continue;
    }

    if (!isXERC20TokenConfig(chainConfig)) {
      throw new Error(
        `Chain "${chainName}" is not an xERC20 compliant deployment`,
      );
    }

    const { token, type, owner, xERC20 } = chainConfig;

    const decimals = warpCoreConfig.tokens.find(
      (t) => t.chainName === chainName,
    )?.decimals;
    if (!decimals) {
      throw new Error(`Missing "decimals" for chain: ${chainName}`);
    }

    if (!xERC20 || xERC20.warpRouteLimits.type !== XERC20Type.Standard) {
      rootLogger.debug(
        `Skip deriving bridges config because ${XERC20Type.Standard} type is expected`,
      );
      continue;
    }
    if (!xERC20.warpRouteLimits.mint || !xERC20.warpRouteLimits.burn) {
      throw new Error(`Missing "limits" for chain: ${chainName}`);
    }

    let xERC20Address = token;
    const bridgeAddress = warpCoreConfig.tokens.find(
      (t) => t.chainName === chainName,
    )?.addressOrDenom;
    if (!bridgeAddress) {
      throw new Error(
        `Missing router address for chain ${chainName} and type ${type}`,
      );
    }

    const mint = Number(xERC20.warpRouteLimits.mint);
    const burn = Number(xERC20.warpRouteLimits.burn);

    if (type === TokenType.XERC20Lockbox) {
      const provider = multiProvider.getProvider(chainName);
      const hypXERC20Lockbox = HypXERC20Lockbox__factory.connect(
        bridgeAddress,
        provider,
      );

      xERC20Address = await hypXERC20Lockbox.xERC20();
    }

    if (xERC20.extraBridges) {
      for (const extraLockboxLimit of xERC20.extraBridges) {
        const { lockbox, limits } = extraLockboxLimit;
        assert(
          limits.type === XERC20Type.Standard,
          `Only supports ${XERC20Type.Standard}`,
        );

        const extraBridgeMint = Number(limits.mint);
        const extraBridgeBurn = Number(limits.burn);

        if (!extraBridgeMint || !extraBridgeBurn) {
          throw new Error(
            `Missing "extraBridgeMint" or "extraBridgeBurn" limits for extra lockbox: ${lockbox} on chain: ${chainName}`,
          );
        }

        bridgesConfig.push({
          chain: chainName as ChainName,
          type,
          xERC20Address,
          bridgeAddress: lockbox,
          owner,
          decimals,
          mint: extraBridgeMint,
          burn: extraBridgeBurn,
        });
      }
    }

    bridgesConfig.push({
      chain: chainName as ChainName,
      type,
      xERC20Address,
      bridgeAddress,
      owner,
      decimals,
      mint,
      burn,
    });
  }

  return bridgesConfig;
}

export async function deriveXERC20TokenType(
  multiProvider: MultiProvider,
  chain: ChainNameOrId,
  address: Address,
): Promise<XERC20Type> {
  const isContract = await isContractAddress(multiProvider, chain, address);
  if (!isContract) {
    throw new Error(
      `Unable to detect XERC20 type for ${address}. Contract has no bytecode.`,
    );
  }

  const provider = multiProvider.getProvider(chain);
  let normalizedCode = (await provider.getCode(address)).toLowerCase();
  const setBufferCapSelector = ethers.utils
    .id('setBufferCap(address,uint256)')
    .slice(2, 10)
    .toLowerCase();
  const setLimitsSelector = ethers.utils
    .id('setLimits(address,uint256,uint256)')
    .slice(2, 10)
    .toLowerCase();

  // xERC20 tokens are commonly deployed behind a proxy whose bytecode does not
  // embed the implementation's selectors; inspect the implementation in that case.
  if (
    !normalizedCode.includes(setBufferCapSelector) &&
    !normalizedCode.includes(setLimitsSelector) &&
    (await isProxy(provider, address))
  ) {
    const implementation = await proxyImplementation(provider, address);
    normalizedCode = (await provider.getCode(implementation)).toLowerCase();
  }

  // Prefer Velodrome if both selectors are present.
  if (normalizedCode.includes(setBufferCapSelector)) {
    return XERC20Type.Velo;
  }

  if (normalizedCode.includes(setLimitsSelector)) {
    return XERC20Type.Standard;
  }

  // Neither type detected
  throw new Error(
    `Unable to detect XERC20 type for ${address}. Contract does not implement Standard or Velodrome XERC20 interface.`,
  );
}
