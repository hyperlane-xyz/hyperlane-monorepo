import { ethers } from 'ethers';
import { Logger } from 'pino';
import { Log, parseEventLogs } from 'viem';

import { HypXERC20Lockbox__factory } from '@hyperlane-xyz/core';
import {
  Address,
  assert,
  bytes32ToAddress,
  normalizeAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { isProxy, proxyImplementation } from '../deploy/proxy.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { WarpCoreConfig } from '../warp/types.js';

import { TokenType } from './config.js';
import {
  WarpRouteDeployConfig,
  XERC20TokenExtraBridgesLimits,
  XERC20Type,
  isXERC20TokenConfig,
} from './types.js';
import {
  BRIDGE_LIMITS_SET_EVENT_SELECTOR,
  CONFIGURATION_CHANGED_EVENT_SELECTOR,
  XERC20_VS_ABI,
} from './xerc20-abi.js';
import { limitsAreZero, readXERC20Limits } from './xerc20-limits.js';

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
  /** Known token type, when the caller has already derived it. */
  type?: XERC20Type;
  /**
   * The warp route's own router. Its limits are reported separately as
   * warpRouteLimits, so leaving it in here would double count the route as a
   * bridge of itself.
   */
  warpRouteAddress?: Address;
};

// xERC20 tokens emit ConfigurationChanged rarely, so scanning them over the
// 500 block default is prohibitively slow. 1_000_000 was measured on base
// specifically, which declares no pagination.maxBlockRange: the token's full
// history was covered in 22 requests (~2.3s). Providers that cap the span
// reject the chunk, and getLogsFromRpc halves the range until it is accepted.
export const XERC20_LOG_SCAN_BLOCK_RANGE = 1_000_000;

/**
 * Reads the bridges the xERC20 holds non-zero limits for, other than the warp
 * route's own router.
 *
 * Neither xERC20 interface can list its bridges: every limit getter is keyed by
 * a bridge address, so the set of addresses is only observable through the
 * events the token emitted when those limits were set. Those events are
 * therefore read for the addresses alone, and every limit is then read from the
 * token, so a bridge reconfigured by something that emits nothing this SDK
 * parses is still reported at the limits it currently holds.
 */
export async function getExtraLockBoxConfigs({
  xERC20Address,
  chain,
  multiProvider,
  logger = rootLogger,
  type: knownType,
  warpRouteAddress,
}: GetExtraLockboxesOptions): Promise<XERC20TokenExtraBridgesLimits[]> {
  const type =
    knownType ??
    (await deriveXERC20TokenType(multiProvider, chain, xERC20Address));
  const bridges = new Set(
    await discoverConfiguredBridges({
      xERC20Address,
      chain,
      multiProvider,
      logger,
      type,
    }),
  );

  if (warpRouteAddress) {
    bridges.delete(normalizeAddress(warpRouteAddress));
  }

  if (bridges.size === 0) {
    return [];
  }

  const limitsByBridge = await readXERC20Limits({
    multiProtocolProvider:
      MultiProtocolProvider.fromMultiProvider(multiProvider),
    chain: multiProvider.getChainName(chain),
    xERC20Address,
    bridges: [...bridges],
    type,
  });

  const extraBridges: XERC20TokenExtraBridgesLimits[] = [];
  for (const bridge of bridges) {
    const limits = limitsByBridge[bridge];
    assert(
      limits,
      `Missing xERC20 limits for bridge ${bridge} on chain ${multiProvider.getChainName(chain)}`,
    );

    // A bridge holding no limits can neither mint nor burn, which is how a
    // bridge is deactivated.
    if (limitsAreZero(limits)) {
      continue;
    }

    extraBridges.push({ lockbox: bridge, limits });
  }

  return extraBridges;
}

/**
 * The event announcing a bridge's limits, whose signature differs by
 * implementation. Both put the bridge in the only indexed parameter, so the
 * scan below reads it out of topics[1] without decoding the payload.
 */
function bridgeLimitsEventSelector(type: XERC20Type): string {
  return type === XERC20Type.Standard
    ? BRIDGE_LIMITS_SET_EVENT_SELECTOR
    : CONFIGURATION_CHANGED_EVENT_SELECTOR;
}

/**
 * Every address the token has ever announced limits for, whether or not those
 * limits are still in force: the limits are read from the token afterwards, so
 * a bridge the events show as deactivated is dropped on what it holds now
 * rather than on what it was last announced with.
 *
 * A failed scan is raised rather than answered as an empty set, because the
 * events are the only place the addresses exist and "no bridges" from a failed
 * read is indistinguishable from a token that genuinely has none.
 */
async function discoverConfiguredBridges({
  xERC20Address,
  chain,
  multiProvider,
  logger,
  type,
}: {
  xERC20Address: Address;
  chain: ChainNameOrId;
  multiProvider: MultiProvider;
  logger: Logger;
  type: XERC20Type;
}): Promise<Address[]> {
  const logsReader = EvmEventLogsReader.fromConfig(
    { chain, paginationBlockRange: XERC20_LOG_SCAN_BLOCK_RANGE },
    multiProvider,
    logger,
  );

  // Resolved once and handed to both reads below. A reader left to derive it
  // reads it over whichever source it was built on, and deriving it over the
  // RPC bisects `eth_getCode` through historical blocks: a chain serving no
  // archive state answers eth_getLogs over its whole history but refuses that
  // bisection, so the RPC read would fail on the one thing it can do.
  const query = {
    contractAddress: xERC20Address,
    eventTopic: bridgeLimitsEventSelector(type),
    fromBlock: await logsReader.getContractDeploymentBlock(xERC20Address),
  };

  let logs = await logsReader.getLogsByTopic(query);

  const answeredByExplorer =
    multiProvider.tryGetEvmExplorerMetadataList(chain).length > 0;
  if (logs.length === 0 && answeredByExplorer) {
    // The token holds limits for at least the warp route's own router, so it
    // has announced at least one bridge and an empty answer is an explorer that
    // could not answer rather than a token with nothing to report.
    //
    // Deliberately this caller's policy rather than EvmEventLogsReader's: a
    // timelock with no salted operations and a freshly deployed blacklist are
    // both legitimately empty, and confirming those over the RPC would spend a
    // whole-history scan to learn what the explorer already answered correctly.
    logger.debug(
      {
        chain: multiProvider.getChainName(chain),
        xERC20Address,
      },
      'Block explorer announced no xERC20 bridges, re-reading over the RPC',
    );

    logs = await EvmEventLogsReader.fromConfig(
      {
        chain,
        paginationBlockRange: XERC20_LOG_SCAN_BLOCK_RANGE,
        useRPC: true,
      },
      multiProvider,
      logger,
    ).getLogsByTopic(query);
  }

  return bridgeAddressesFromLogs(logs, xERC20Address, chain, multiProvider);
}

function bridgeAddressesFromLogs(
  logs: GetEventLogsResponse[],
  xERC20Address: Address,
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): Address[] {
  return logs.map((log) => {
    const [, bridgeTopic] = log.topics;
    assert(
      bridgeTopic,
      `Bridge limits log of ${xERC20Address} on chain ${multiProvider.getChainName(chain)} carries no bridge topic`,
    );

    return normalizeAddress(bytes32ToAddress(bridgeTopic));
  });
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

/**
 * Thrown when a contract exposes neither the Standard nor the Velodrome limit
 * management interface, so which getter would answer its limits is unknown.
 *
 * Typed rather than a bare Error so a caller can tell it apart from a failure
 * to read the bytecode at all, which says nothing about the contract and must
 * not be treated as an answer.
 */
export class UnknownXERC20TypeError extends Error {
  static {
    this.prototype.name = this.name;
  }
}

export async function deriveXERC20TokenType(
  multiProvider: MultiProvider,
  chain: ChainNameOrId,
  address: Address,
): Promise<XERC20Type> {
  const provider = multiProvider.getProvider(chain);
  let normalizedCode = (await provider.getCode(address)).toLowerCase();
  if (normalizedCode === '0x') {
    throw new Error(
      `Unable to detect XERC20 type for ${address}. Contract has no bytecode.`,
    );
  }

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
  throw new UnknownXERC20TypeError(
    `Unable to detect XERC20 type for ${address}. Contract does not implement Standard or Velodrome XERC20 interface.`,
  );
}
