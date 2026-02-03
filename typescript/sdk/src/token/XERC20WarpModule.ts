import { PopulatedTransaction } from 'ethers';

import { HypXERC20Lockbox__factory } from '@hyperlane-xyz/core';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName } from '../types.js';
import { WarpCoreConfig } from '../warp/types.js';

import {
  EvmXERC20Adapter,
  EvmXERC20VSAdapter,
} from './adapters/EvmTokenAdapter.js';
import { RateLimitMidPoint, xERC20Limits } from './adapters/ITokenAdapter.js';
import { TokenType } from './config.js';
import {
  WarpRouteDeployConfig,
  XERC20Type,
  isXERC20TokenConfig,
} from './types.js';
import { detectXERC20Type } from './xerc20.js';

/**
 * Standard XERC20 limits (mint/burn max limits)
 */
export interface StandardXERC20Limits {
  type: 'standard';
  mint: string; // uint256 as string
  burn: string; // uint256 as string
}

/**
 * Velodrome XERC20 limits (bufferCap/rateLimitPerSecond)
 */
export interface VelodromeXERC20Limits {
  type: 'velodrome';
  bufferCap: string;
  rateLimitPerSecond: string;
}

/**
 * Unified XERC20 limits type
 */
export type XERC20Limits = StandardXERC20Limits | VelodromeXERC20Limits;

/**
 * Map of bridge addresses to their limits
 */
export type XERC20LimitsMap = Record<Address, XERC20Limits>;

/**
 * Drift detection result
 */
export interface XERC20DriftResult {
  chain: ChainName;
  xERC20Address: Address;
  xerc20Type: 'standard' | 'velodrome';
  missingBridges: Address[]; // In config but not on-chain
  extraBridges: Address[]; // On-chain but not in config
  limitMismatches: Array<{
    bridge: Address;
    expected: XERC20Limits;
    actual: XERC20Limits;
  }>;
}

/**
 * Module for managing XERC20 mint/burn limits and bridges.
 * Supports both Standard XERC20 (setLimits) and Velodrome XERC20 (setBufferCap/addBridge/removeBridge).
 */
export class XERC20WarpModule {
  protected logger = rootLogger.child({ module: 'XERC20WarpModule' });
  protected readonly multiProtocolProvider: MultiProtocolProvider;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly warpRouteConfig: WarpRouteDeployConfig,
    protected readonly warpCoreConfig: WarpCoreConfig,
  ) {
    this.multiProtocolProvider =
      MultiProtocolProvider.fromMultiProvider(multiProvider);
  }

  /**
   * Get the warp route bridge address for a chain from the warp core config.
   */
  protected getWarpRouteBridgeAddress(chain: ChainName): Address {
    const token = this.warpCoreConfig.tokens.find((t) => t.chainName === chain);
    assert(
      token?.addressOrDenom,
      `Missing warp route address for chain ${chain} in warpCoreConfig`,
    );
    return token.addressOrDenom;
  }

  /**
   * Get the xERC20 token address for a chain from the warp config.
   * Handles both XERC20 and XERC20Lockbox types.
   */
  protected async getXERC20Address(chain: ChainName): Promise<Address> {
    const chainConfig = this.warpRouteConfig[chain];
    assert(
      chainConfig && isXERC20TokenConfig(chainConfig),
      `Chain ${chain} is not an XERC20 config`,
    );

    if (chainConfig.type === TokenType.XERC20Lockbox) {
      const provider = this.multiProvider.getProvider(chain);
      const hypXERC20Lockbox = HypXERC20Lockbox__factory.connect(
        chainConfig.token,
        provider,
      );
      return hypXERC20Lockbox.xERC20();
    }

    return chainConfig.token;
  }

  /**
   * Detect the XERC20 type (standard or velodrome) for a chain.
   */
  async detectType(chain: ChainName): Promise<'standard' | 'velodrome'> {
    const xERC20Address = await this.getXERC20Address(chain);
    const provider = this.multiProvider.getProvider(chain);
    return detectXERC20Type(provider, xERC20Address);
  }

  /**
   * Generate transactions to set limits for a bridge on a Standard XERC20.
   * For Velodrome, use generateAddBridgeTxs or individual setBufferCap/setRateLimitPerSecond.
   */
  async generateSetLimitsTxs(
    chain: ChainName,
    bridge: Address,
    limits: XERC20Limits,
  ): Promise<AnnotatedEV5Transaction[]> {
    const xERC20Address = await this.getXERC20Address(chain);
    const chainId = this.multiProvider.getEvmChainId(chain);
    const transactions: AnnotatedEV5Transaction[] = [];

    if (limits.type === 'standard') {
      const adapter = new EvmXERC20Adapter(chain, this.multiProtocolProvider, {
        token: xERC20Address,
      });

      const tx = await adapter.populateSetLimitsTx(
        bridge,
        BigInt(limits.mint),
        BigInt(limits.burn),
      );

      transactions.push(this.annotateTransaction(tx, chainId, xERC20Address));
    } else {
      const adapter = new EvmXERC20VSAdapter(
        chain,
        this.multiProtocolProvider,
        {
          token: xERC20Address,
        },
      );

      const bufferCapTx = await adapter.populateSetBufferCapTx(
        bridge,
        BigInt(limits.bufferCap),
      );
      transactions.push(
        this.annotateTransaction(bufferCapTx, chainId, xERC20Address),
      );

      const rateLimitTx = await adapter.populateSetRateLimitPerSecondTx(
        bridge,
        BigInt(limits.rateLimitPerSecond),
      );
      transactions.push(
        this.annotateTransaction(rateLimitTx, chainId, xERC20Address),
      );
    }

    return transactions;
  }

  /**
   * Generate transactions to add a bridge to an XERC20.
   * For Standard XERC20, this is equivalent to setLimits.
   * For Velodrome XERC20, this uses the addBridge function.
   */
  async generateAddBridgeTxs(
    chain: ChainName,
    bridge: Address,
    limits: XERC20Limits,
  ): Promise<AnnotatedEV5Transaction[]> {
    const xERC20Address = await this.getXERC20Address(chain);
    const chainId = this.multiProvider.getEvmChainId(chain);
    const transactions: AnnotatedEV5Transaction[] = [];

    if (limits.type === 'standard') {
      return this.generateSetLimitsTxs(chain, bridge, limits);
    }

    const adapter = new EvmXERC20VSAdapter(chain, this.multiProtocolProvider, {
      token: xERC20Address,
    });

    const tx = await adapter.populateAddBridgeTx(
      BigInt(limits.bufferCap),
      BigInt(limits.rateLimitPerSecond),
      bridge,
    );

    transactions.push(this.annotateTransaction(tx, chainId, xERC20Address));
    return transactions;
  }

  /**
   * Generate transactions to remove a bridge from a Velodrome XERC20.
   * Note: Only supported for Velodrome XERC20. Standard XERC20 does not support bridge removal.
   * @throws Error if the chain's XERC20 is Standard type
   */
  async generateRemoveBridgeTxs(
    chain: ChainName,
    bridge: Address,
  ): Promise<AnnotatedEV5Transaction[]> {
    const xERC20Address = await this.getXERC20Address(chain);
    const xerc20Type = await this.detectType(chain);
    const chainId = this.multiProvider.getEvmChainId(chain);

    assert(
      xerc20Type === 'velodrome',
      `removeBridge is only supported for Velodrome XERC20. Chain ${chain} has Standard XERC20.`,
    );

    const adapter = new EvmXERC20VSAdapter(chain, this.multiProtocolProvider, {
      token: xERC20Address,
    });

    const tx = await adapter.populateRemoveBridgeTx(bridge);
    return [this.annotateTransaction(tx, chainId, xERC20Address)];
  }

  /**
   * Read current limits for bridges on an XERC20.
   * @param chain - Chain to read from
   * @param bridges - Optional specific bridges to read. If not provided, reads the warp route bridge.
   */
  async readLimits(
    chain: ChainName,
    bridges?: Address[],
  ): Promise<XERC20LimitsMap> {
    const xERC20Address = await this.getXERC20Address(chain);
    const xerc20Type = await this.detectType(chain);

    const limitsMap: XERC20LimitsMap = {};
    const bridgesToRead = bridges ?? this.getConfiguredBridges(chain);

    if (xerc20Type === 'standard') {
      const adapter = new EvmXERC20Adapter(chain, this.multiProtocolProvider, {
        token: xERC20Address,
      });

      for (const bridge of bridgesToRead) {
        const limits = await adapter.getLimits(bridge);
        limitsMap[bridge] = this.toStandardLimits(limits);
      }
    } else {
      const adapter = new EvmXERC20VSAdapter(
        chain,
        this.multiProtocolProvider,
        {
          token: xERC20Address,
        },
      );

      for (const bridge of bridgesToRead) {
        const rateLimits = await adapter.getRateLimits(bridge);
        limitsMap[bridge] = this.toVelodromeLimits(rateLimits);
      }
    }

    return limitsMap;
  }

  /**
   * Detect configuration drift for XERC20 limits on a chain.
   * Compares expected config with on-chain state.
   */
  async detectDrift(chain: ChainName): Promise<XERC20DriftResult> {
    const chainConfig = this.warpRouteConfig[chain];
    assert(
      chainConfig && isXERC20TokenConfig(chainConfig),
      `Chain ${chain} is not an XERC20 config`,
    );

    const xERC20Address = await this.getXERC20Address(chain);
    const xerc20Type = await this.detectType(chain);
    const expectedLimits = this.getExpectedLimitsFromConfig(chain);

    const result: XERC20DriftResult = {
      chain,
      xERC20Address,
      xerc20Type,
      missingBridges: [],
      extraBridges: [],
      limitMismatches: [],
    };

    const expectedBridges = Object.keys(expectedLimits);
    const actualLimits = await this.readLimits(chain, expectedBridges);

    for (const [bridge, expected] of Object.entries(expectedLimits)) {
      const actual = actualLimits[bridge];

      if (!actual || this.limitsAreZero(actual)) {
        result.missingBridges.push(bridge);
        continue;
      }

      if (!this.limitsMatch(expected, actual)) {
        result.limitMismatches.push({ bridge, expected, actual });
      }
    }

    return result;
  }

  /**
   * Generate transactions to correct detected drift.
   */
  async generateDriftCorrectionTxs(
    drift: XERC20DriftResult,
  ): Promise<AnnotatedEV5Transaction[]> {
    const transactions: AnnotatedEV5Transaction[] = [];
    const expectedLimits = this.getExpectedLimitsFromConfig(drift.chain);

    for (const bridge of drift.missingBridges) {
      const limits = expectedLimits[bridge];
      if (limits) {
        const txs = await this.generateAddBridgeTxs(
          drift.chain,
          bridge,
          limits,
        );
        transactions.push(...txs);
      }
    }

    for (const mismatch of drift.limitMismatches) {
      const txs = await this.generateSetLimitsTxs(
        drift.chain,
        mismatch.bridge,
        mismatch.expected,
      );
      transactions.push(...txs);
    }

    if (drift.xerc20Type === 'velodrome') {
      for (const bridge of drift.extraBridges) {
        const txs = await this.generateRemoveBridgeTxs(drift.chain, bridge);
        transactions.push(...txs);
      }
    }

    return transactions;
  }

  /**
   * Get the expected limits from config for a chain
   */
  protected getExpectedLimitsFromConfig(chain: ChainName): XERC20LimitsMap {
    const chainConfig = this.warpRouteConfig[chain];
    assert(
      chainConfig && isXERC20TokenConfig(chainConfig),
      `Chain ${chain} is not an XERC20 config`,
    );

    const limitsMap: XERC20LimitsMap = {};
    const xERC20 = chainConfig.xERC20;

    if (!xERC20?.warpRouteLimits) {
      return limitsMap;
    }

    const warpRouteLimits = xERC20.warpRouteLimits;
    const warpRouteBridge = this.getWarpRouteBridgeAddress(chain);

    if (warpRouteLimits.type === XERC20Type.Standard) {
      if (warpRouteLimits.mint && warpRouteLimits.burn) {
        limitsMap[warpRouteBridge] = {
          type: 'standard',
          mint: warpRouteLimits.mint,
          burn: warpRouteLimits.burn,
        };
      }
    } else if (warpRouteLimits.type === XERC20Type.Velo) {
      if (warpRouteLimits.bufferCap && warpRouteLimits.rateLimitPerSecond) {
        limitsMap[warpRouteBridge] = {
          type: 'velodrome',
          bufferCap: warpRouteLimits.bufferCap,
          rateLimitPerSecond: warpRouteLimits.rateLimitPerSecond,
        };
      }
    }

    if (xERC20.extraBridges) {
      for (const extraBridge of xERC20.extraBridges) {
        const { lockbox, limits } = extraBridge;
        if (limits.type === XERC20Type.Standard) {
          if (limits.mint && limits.burn) {
            limitsMap[lockbox] = {
              type: 'standard',
              mint: limits.mint,
              burn: limits.burn,
            };
          }
        } else if (limits.type === XERC20Type.Velo) {
          if (limits.bufferCap && limits.rateLimitPerSecond) {
            limitsMap[lockbox] = {
              type: 'velodrome',
              bufferCap: limits.bufferCap,
              rateLimitPerSecond: limits.rateLimitPerSecond,
            };
          }
        }
      }
    }

    return limitsMap;
  }

  /**
   * Get configured bridges for a chain from the warp config
   */
  protected getConfiguredBridges(chain: ChainName): Address[] {
    const chainConfig = this.warpRouteConfig[chain];
    if (!chainConfig || !isXERC20TokenConfig(chainConfig)) {
      return [];
    }

    const warpRouteBridge = this.getWarpRouteBridgeAddress(chain);
    const bridges: Address[] = [warpRouteBridge];

    if (chainConfig.xERC20?.extraBridges) {
      for (const extra of chainConfig.xERC20.extraBridges) {
        bridges.push(extra.lockbox);
      }
    }

    return bridges;
  }

  /**
   * Convert xERC20Limits to StandardXERC20Limits
   */
  protected toStandardLimits(limits: xERC20Limits): StandardXERC20Limits {
    return {
      type: 'standard',
      mint: limits.mint.toString(),
      burn: limits.burn.toString(),
    };
  }

  /**
   * Convert RateLimitMidPoint to VelodromeXERC20Limits
   */
  protected toVelodromeLimits(
    rateLimits: RateLimitMidPoint,
  ): VelodromeXERC20Limits {
    return {
      type: 'velodrome',
      bufferCap: rateLimits.bufferCap.toString(),
      rateLimitPerSecond: rateLimits.rateLimitPerSecond.toString(),
    };
  }

  /**
   * Check if limits are zero (bridge not configured)
   */
  protected limitsAreZero(limits: XERC20Limits): boolean {
    if (limits.type === 'standard') {
      return limits.mint === '0' && limits.burn === '0';
    }
    return limits.bufferCap === '0' && limits.rateLimitPerSecond === '0';
  }

  /**
   * Check if two limits match
   */
  protected limitsMatch(a: XERC20Limits, b: XERC20Limits): boolean {
    if (a.type !== b.type) return false;

    if (a.type === 'standard' && b.type === 'standard') {
      return a.mint === b.mint && a.burn === b.burn;
    }

    if (a.type === 'velodrome' && b.type === 'velodrome') {
      return (
        a.bufferCap === b.bufferCap &&
        a.rateLimitPerSecond === b.rateLimitPerSecond
      );
    }

    return false;
  }

  /**
   * Annotate a transaction with chain ID and target address
   */
  protected annotateTransaction(
    tx: PopulatedTransaction,
    chainId: number,
    to: Address,
  ): AnnotatedEV5Transaction {
    return {
      ...tx,
      chainId,
      to,
      annotation: `XERC20 limit update for ${to}`,
    };
  }
}
