import { ethers } from 'ethers';

import { Ownable__factory, ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  Address,
  eqAddress,
  normalizeAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { proxyAdmin } from '../deploy/proxy.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { viemLogFromGetEventLogsResponse } from '../rpc/evm/utils.js';
import { ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
  EvmXERC20Adapter,
  EvmXERC20VSAdapter,
} from './adapters/EvmTokenAdapter.js';
import { RateLimitMidPoint, xERC20Limits } from './adapters/ITokenAdapter.js';
import { XERC20Type } from './types.js';
import { CONFIGURATION_CHANGED_EVENT_SELECTOR } from './xerc20-abi.js';
import {
  XERC20_LOG_SCAN_BLOCK_RANGE,
  deriveXERC20TokenType,
  latestConfigurationPerBridge,
} from './xerc20.js';

export interface StandardXERC20Limits {
  type: typeof XERC20Type.Standard;
  mint: string;
  burn: string;
}

export interface VeloXERC20Limits {
  type: typeof XERC20Type.Velo;
  bufferCap: string;
  rateLimitPerSecond: string;
}

/**
 * Unified XERC20 limits type
 */
export type XERC20Limits = StandardXERC20Limits | VeloXERC20Limits;

/**
 * Map of bridge addresses to their limits
 */
export type XERC20LimitsMap = Record<Address, XERC20Limits>;

/**
 * Reader for on-chain XERC20 state.
 * Reads limits and bridge configurations from XERC20 contracts.
 */
export class EvmXERC20Reader extends HyperlaneReader {
  protected logger = rootLogger.child({ module: 'EvmXERC20Reader' });
  protected readonly multiProtocolProvider: MultiProtocolProvider;

  constructor(
    protected readonly multiProvider: MultiProvider,
    chain: ChainNameOrId,
  ) {
    super(multiProvider, chain);
    this.multiProtocolProvider =
      MultiProtocolProvider.fromMultiProvider(multiProvider);
  }

  async deriveXERC20TokenType(xERC20Address: Address): Promise<XERC20Type> {
    return deriveXERC20TokenType(this.multiProvider, this.chain, xERC20Address);
  }

  /**
   * Read current limits for the specified bridges.
   */
  async readLimits(
    xERC20Address: Address,
    bridges: Address[],
    type: XERC20Type,
  ): Promise<XERC20LimitsMap> {
    const limitsMap: XERC20LimitsMap = {};
    const chainName = this.multiProvider.getChainName(this.chain);

    if (type === XERC20Type.Standard) {
      const adapter = new EvmXERC20Adapter(
        chainName,
        this.multiProtocolProvider,
        { token: xERC20Address },
      );

      for (const bridge of bridges) {
        const limits = await adapter.getLimits(bridge);
        limitsMap[bridge] = this.toStandardLimits(limits);
      }
    } else {
      const adapter = new EvmXERC20VSAdapter(
        chainName,
        this.multiProtocolProvider,
        { token: xERC20Address },
      );

      for (const bridge of bridges) {
        const rateLimits = await adapter.getRateLimits(bridge);
        limitsMap[bridge] = this.toVeloLimits(rateLimits);
      }
    }

    return limitsMap;
  }

  /**
   * Read all bridges configured on-chain for a Velodrome XERC20 by parsing ConfigurationChanged events.
   * Returns empty array for Standard XERC20 since it has no event-based bridge enumeration.
   * The scan covers the token's whole history, from the block it was deployed in
   * to the chain head, over the block explorer where the chain has a usable one
   * and over the paginated RPC otherwise.
   */
  async readOnChainBridges(
    xERC20Address: Address,
    type: XERC20Type,
  ): Promise<Address[]> {
    if (type === XERC20Type.Standard) {
      this.logger.debug(
        'Standard XERC20 does not support on-chain bridge enumeration',
      );
      return [];
    }

    const logsReader = EvmEventLogsReader.fromConfig(
      { chain: this.chain, paginationBlockRange: XERC20_LOG_SCAN_BLOCK_RANGE },
      this.multiProvider,
      this.logger,
    );

    const rawLogs = await logsReader.getLogsByTopic({
      contractAddress: xERC20Address,
      eventTopic: CONFIGURATION_CHANGED_EVENT_SELECTOR,
    });

    const bridgeToLatestLog = latestConfigurationPerBridge(
      rawLogs.map(viemLogFromGetEventLogsResponse),
    );

    // Filter to active bridges (non-zero limits)
    const activeBridges: Address[] = [];
    for (const [bridge, log] of bridgeToLatestLog) {
      const hasNonZeroLimits =
        log.args.bufferCap !== 0n || log.args.rateLimitPerSecond !== 0n;
      if (hasNonZeroLimits) {
        activeBridges.push(bridge);
      }
    }

    return activeBridges;
  }

  /**
   * Read the owner of the XERC20 token contract.
   * This owner controls limit/bridge management (setBufferCap, addBridge, etc.).
   * Returns undefined if the XERC20 does not expose `owner()` (e.g. a
   * third-party token using AccessControl instead of Ownable) so callers on the
   * warp read/apply path don't break on non-Ownable tokens.
   */
  async readOwner(xERC20Address: Address): Promise<Address | undefined> {
    try {
      const owner = await Ownable__factory.connect(
        xERC20Address,
        this.provider,
      ).owner();
      return normalizeAddress(owner);
    } catch (error) {
      this.logger.debug(
        { xERC20Address, error },
        'XERC20 does not expose owner(); treating owner as undefined',
      );
      return undefined;
    }
  }

  /**
   * Read the ProxyAdmin for the XERC20 proxy and its owner.
   * The ProxyAdmin owner controls upgrades. Returns undefined if the XERC20 is
   * not behind a transparent proxy.
   */
  async readProxyAdmin(
    xERC20Address: Address,
  ): Promise<{ address: Address; owner: Address } | undefined> {
    const proxyAdminAddress = await proxyAdmin(this.provider, xERC20Address);
    if (eqAddress(proxyAdminAddress, ethers.constants.AddressZero)) {
      return undefined;
    }

    const owner = await ProxyAdmin__factory.connect(
      proxyAdminAddress,
      this.provider,
    ).owner();

    return {
      address: normalizeAddress(proxyAdminAddress),
      owner: normalizeAddress(owner),
    };
  }

  protected toStandardLimits(limits: xERC20Limits): StandardXERC20Limits {
    return {
      type: XERC20Type.Standard,
      mint: limits.mint.toString(),
      burn: limits.burn.toString(),
    };
  }

  protected toVeloLimits(rateLimits: RateLimitMidPoint): VeloXERC20Limits {
    return {
      type: XERC20Type.Velo,
      bufferCap: rateLimits.bufferCap.toString(),
      rateLimitPerSecond: rateLimits.rateLimitPerSecond.toString(),
    };
  }
}

export function limitsAreZero(limits: XERC20Limits): boolean {
  if (limits.type === XERC20Type.Standard) {
    return limits.mint === '0' && limits.burn === '0';
  }
  return limits.bufferCap === '0' && limits.rateLimitPerSecond === '0';
}

export function limitsMatch(a: XERC20Limits, b: XERC20Limits): boolean {
  if (a.type !== b.type) return false;

  if (a.type === XERC20Type.Standard && b.type === XERC20Type.Standard) {
    return a.mint === b.mint && a.burn === b.burn;
  }

  if (a.type === XERC20Type.Velo && b.type === XERC20Type.Velo) {
    return (
      a.bufferCap === b.bufferCap &&
      a.rateLimitPerSecond === b.rateLimitPerSecond
    );
  }

  return false;
}
