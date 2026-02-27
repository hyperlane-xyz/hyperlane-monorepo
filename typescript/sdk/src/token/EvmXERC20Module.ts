import { TransactionRequest } from 'ethers';

import { IXERC20Lockbox__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  assert,
  normalizeAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEvmTransaction } from '../providers/ProviderType.js';
import { ChainName } from '../types.js';

import {
  EvmXERC20Reader,
  XERC20Limits,
  XERC20LimitsMap,
  limitsAreZero,
  limitsMatch,
} from './EvmXERC20Reader.js';
import {
  EvmXERC20Adapter,
  EvmXERC20VSAdapter,
} from './adapters/EvmTokenAdapter.js';
import { TokenType } from './config.js';
import { XERC20Type } from './types.js';

type PopulatedTransaction = TransactionRequest;

/**
 * Configuration for XERC20 limits management
 */
export interface XERC20ModuleConfig {
  type: XERC20Type;
  limits: XERC20LimitsMap;
}

/**
 * Addresses managed by the XERC20 module
 */
export interface XERC20ModuleAddresses {
  xERC20: Address;
  warpRoute: Address;
}

/**
 * Module for managing XERC20 mint/burn limits and bridges.
 * Follows HyperlaneModule pattern with read() and update() methods.
 * Supports both Standard XERC20 (setLimits) and Velodrome XERC20 (setBufferCap/addBridge/removeBridge).
 */
export class EvmXERC20Module extends HyperlaneModule<
  ProtocolType.Ethereum,
  XERC20ModuleConfig,
  XERC20ModuleAddresses
> {
  protected logger = rootLogger.child({ module: 'EvmXERC20Module' });
  public readonly reader: EvmXERC20Reader;
  protected readonly multiProtocolProvider: MultiProtocolProvider;
  public readonly chainName: ChainName;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<XERC20ModuleConfig, XERC20ModuleAddresses>,
  ) {
    super(args);
    this.chainName = this.multiProvider.getChainName(args.chain);
    this.reader = new EvmXERC20Reader(multiProvider, args.chain);
    this.multiProtocolProvider =
      MultiProtocolProvider.fromMultiProvider(multiProvider);
  }

  async read(): Promise<XERC20ModuleConfig> {
    const type = await this.reader.deriveXERC20TokenType(
      this.args.addresses.xERC20,
    );
    let bridges = this.getExpectedBridges();

    if (type === XERC20Type.Velo) {
      const onChainBridges = await this.reader.readOnChainBridges(
        this.args.addresses.xERC20,
        type,
      );
      bridges = [...new Set([...bridges, ...onChainBridges])];
    }

    const limits = await this.reader.readLimits(
      this.args.addresses.xERC20,
      bridges,
      type,
    );
    return { type, limits };
  }

  /**
   * Generate transactions to update XERC20 limits to match expected config.
   * Detects drift and generates correction transactions.
   */
  async update(
    expectedConfig: XERC20ModuleConfig,
  ): Promise<AnnotatedEvmTransaction[]> {
    const actualConfig = await this.read();

    assert(
      expectedConfig.type === actualConfig.type,
      `XERC20 type mismatch: expected ${expectedConfig.type} but on-chain is ${actualConfig.type}`,
    );

    const transactions: AnnotatedEvmTransaction[] = [];

    const { missingBridges, extraBridges, limitMismatches } =
      this.detectDriftFromConfigs(expectedConfig, actualConfig);

    for (const bridge of missingBridges) {
      const limits = expectedConfig.limits[bridge];
      if (limits) {
        const txs = await this.generateAddBridgeTxs(bridge, limits);
        transactions.push(...txs);
      }
    }

    for (const { bridge, expected } of limitMismatches) {
      const txs = await this.generateSetLimitsTxs(bridge, expected);
      transactions.push(...txs);
    }

    if (expectedConfig.type === XERC20Type.Velo) {
      for (const bridge of extraBridges) {
        const txs = await this.generateRemoveBridgeTxs(bridge);
        transactions.push(...txs);
      }
    }

    if (transactions.length > 0) {
      this.logger.info(
        `Generated ${transactions.length} XERC20 correction txs: ` +
          `${missingBridges.length} missing, ${limitMismatches.length} mismatches, ${extraBridges.length} extra`,
      );
    }

    return transactions;
  }

  /**
   * Detect drift between expected and actual configurations.
   */
  protected detectDriftFromConfigs(
    expected: XERC20ModuleConfig,
    actual: XERC20ModuleConfig,
  ): {
    missingBridges: Address[];
    extraBridges: Address[];
    limitMismatches: Array<{
      bridge: Address;
      expected: XERC20Limits;
      actual: XERC20Limits;
    }>;
  } {
    const missingBridges: Address[] = [];
    const limitMismatches: Array<{
      bridge: Address;
      expected: XERC20Limits;
      actual: XERC20Limits;
    }> = [];

    const expectedBridges = Object.keys(expected.limits).map((addr) =>
      normalizeAddress(addr),
    );
    const expectedBridgesSet = new Set(expectedBridges);

    for (const [bridge, expectedLimits] of Object.entries(expected.limits)) {
      const normalizedBridge = normalizeAddress(bridge);
      const actualLimits =
        actual.limits[normalizedBridge] ?? actual.limits[bridge];

      if (!actualLimits || limitsAreZero(actualLimits)) {
        missingBridges.push(bridge);
        continue;
      }

      if (!limitsMatch(expectedLimits, actualLimits)) {
        limitMismatches.push({
          bridge,
          expected: expectedLimits,
          actual: actualLimits,
        });
      }
    }

    let extraBridges: Address[] = [];
    if (expected.type === XERC20Type.Velo) {
      extraBridges = Object.keys(actual.limits)
        .filter((addr) => {
          const normalized = normalizeAddress(addr);
          return (
            !expectedBridgesSet.has(normalized) &&
            !limitsAreZero(actual.limits[addr])
          );
        })
        .map((addr) => normalizeAddress(addr));
    }

    return { missingBridges, extraBridges, limitMismatches };
  }

  /**
   * Get expected bridge addresses from config.
   */
  protected getExpectedBridges(): Address[] {
    return Object.keys(this.args.config.limits);
  }

  /**
   * Generate transactions to set limits for a bridge.
   */
  async generateSetLimitsTxs(
    bridge: Address,
    limits: XERC20Limits,
  ): Promise<AnnotatedEvmTransaction[]> {
    const xERC20Address = this.args.addresses.xERC20;
    const chainId = this.multiProvider.getEvmChainId(this.chainName);
    const transactions: AnnotatedEvmTransaction[] = [];

    if (limits.type === XERC20Type.Standard) {
      const adapter = new EvmXERC20Adapter(
        this.chainName,
        this.multiProtocolProvider,
        { token: xERC20Address },
      );

      const tx = await adapter.populateSetLimitsTx(
        bridge,
        BigInt(limits.mint),
        BigInt(limits.burn),
      );
      transactions.push(this.annotateTransaction(tx, chainId, xERC20Address));
    } else {
      const adapter = new EvmXERC20VSAdapter(
        this.chainName,
        this.multiProtocolProvider,
        { token: xERC20Address },
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
   * Generate transactions to add a bridge.
   * For Standard XERC20, equivalent to setLimits.
   * For Velodrome, uses addBridge function.
   */
  async generateAddBridgeTxs(
    bridge: Address,
    limits: XERC20Limits,
  ): Promise<AnnotatedEvmTransaction[]> {
    if (limits.type === XERC20Type.Standard) {
      return this.generateSetLimitsTxs(bridge, limits);
    }

    const xERC20Address = this.args.addresses.xERC20;
    const chainId = this.multiProvider.getEvmChainId(this.chainName);

    const adapter = new EvmXERC20VSAdapter(
      this.chainName,
      this.multiProtocolProvider,
      { token: xERC20Address },
    );

    const tx = await adapter.populateAddBridgeTx(
      BigInt(limits.bufferCap),
      BigInt(limits.rateLimitPerSecond),
      bridge,
    );

    return [this.annotateTransaction(tx, chainId, xERC20Address)];
  }

  /**
   * Generate transactions to remove a bridge (Velodrome only).
   */
  async generateRemoveBridgeTxs(
    bridge: Address,
  ): Promise<AnnotatedEvmTransaction[]> {
    const xERC20Address = this.args.addresses.xERC20;
    const chainId = this.multiProvider.getEvmChainId(this.chainName);

    const adapter = new EvmXERC20VSAdapter(
      this.chainName,
      this.multiProtocolProvider,
      { token: xERC20Address },
    );

    const tx = await adapter.populateRemoveBridgeTx(bridge);
    return [this.annotateTransaction(tx, chainId, xERC20Address)];
  }

  protected annotateTransaction(
    tx: PopulatedTransaction,
    chainId: number,
    to: Address,
  ): AnnotatedEvmTransaction {
    return {
      ...tx,
      chainId,
      to,
      annotation: `XERC20 limit update for ${to}`,
    };
  }

  static async fromWarpRouteConfig(
    multiProvider: MultiProvider,
    chain: ChainName,
    warpRouteConfig: {
      type: string;
      token: Address;
      xERC20?: {
        warpRouteLimits: {
          type: XERC20Type;
          mint?: string;
          burn?: string;
          bufferCap?: string;
          rateLimitPerSecond?: string;
        };
        extraBridges?: Array<{
          lockbox: Address;
          limits: {
            type: XERC20Type;
            mint?: string;
            burn?: string;
            bufferCap?: string;
            rateLimitPerSecond?: string;
          };
        }>;
      };
    },
    warpRouteAddress: Address,
  ): Promise<{ module: EvmXERC20Module; config: XERC20ModuleConfig }> {
    assert(
      warpRouteConfig.type === TokenType.XERC20 ||
        warpRouteConfig.type === TokenType.XERC20Lockbox,
      `Expected XERC20 or XERC20Lockbox token type, got ${warpRouteConfig.type}`,
    );

    let xERC20Address = warpRouteConfig.token;
    if (warpRouteConfig.type === TokenType.XERC20Lockbox) {
      const provider = multiProvider.getProvider(chain);
      const lockbox = IXERC20Lockbox__factory.connect(
        warpRouteConfig.token,
        provider,
      );
      xERC20Address = await lockbox.XERC20.staticCall();
    }

    const limits: XERC20LimitsMap = {};
    const xERC20Config = warpRouteConfig.xERC20;
    const warpRouteLimits = xERC20Config?.warpRouteLimits;

    if (warpRouteLimits) {
      if (warpRouteLimits.type === XERC20Type.Standard) {
        if (warpRouteLimits.mint != null && warpRouteLimits.burn != null) {
          limits[warpRouteAddress] = {
            type: XERC20Type.Standard,
            mint: warpRouteLimits.mint,
            burn: warpRouteLimits.burn,
          };
        }
      } else if (warpRouteLimits.type === XERC20Type.Velo) {
        if (
          warpRouteLimits.bufferCap != null &&
          warpRouteLimits.rateLimitPerSecond != null
        ) {
          limits[warpRouteAddress] = {
            type: XERC20Type.Velo,
            bufferCap: warpRouteLimits.bufferCap,
            rateLimitPerSecond: warpRouteLimits.rateLimitPerSecond,
          };
        }
      }
    }

    if (xERC20Config?.extraBridges) {
      for (const extraBridge of xERC20Config.extraBridges) {
        const { lockbox, limits: bridgeLimits } = extraBridge;
        if (bridgeLimits.type === XERC20Type.Standard) {
          if (bridgeLimits.mint != null && bridgeLimits.burn != null) {
            limits[lockbox] = {
              type: XERC20Type.Standard,
              mint: bridgeLimits.mint,
              burn: bridgeLimits.burn,
            };
          }
        } else if (bridgeLimits.type === XERC20Type.Velo) {
          if (
            bridgeLimits.bufferCap != null &&
            bridgeLimits.rateLimitPerSecond != null
          ) {
            limits[lockbox] = {
              type: XERC20Type.Velo,
              bufferCap: bridgeLimits.bufferCap,
              rateLimitPerSecond: bridgeLimits.rateLimitPerSecond,
            };
          }
        }
      }
    }

    const type: XERC20Type = warpRouteLimits?.type
      ? warpRouteLimits.type
      : await new EvmXERC20Reader(multiProvider, chain).deriveXERC20TokenType(
          xERC20Address,
        );

    const config: XERC20ModuleConfig = { type, limits };
    const module = new EvmXERC20Module(multiProvider, {
      addresses: { xERC20: xERC20Address, warpRoute: warpRouteAddress },
      chain,
      config,
    });

    return { module, config };
  }
}
