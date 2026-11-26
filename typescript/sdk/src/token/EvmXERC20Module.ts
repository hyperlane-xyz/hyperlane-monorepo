import { PopulatedTransaction, utils } from 'ethers';

import { IXERC20Lockbox__factory } from '@hyperlane-xyz/core';
import {
  Address,
  EvmChainId,
  ProtocolType,
  assert,
  eqAddress,
  isNullish,
  isZeroishAddressEvm,
  normalizeAddress,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName, DeployedOwnableConfig, OwnableConfig } from '../types.js';

import {
  AevoXERC20Limits,
  EvmXERC20Reader,
  VeloXERC20Limits,
  XERC20Limits,
  XERC20LimitsMap,
  limitsAreZero,
  limitsMatch,
} from './EvmXERC20Reader.js';
import {
  EvmXERC20AevoAdapter,
  EvmXERC20Adapter,
  EvmXERC20VSAdapter,
} from './adapters/EvmTokenAdapter.js';
import { TokenType } from './config.js';
import {
  XERC20AevoCapType,
  XERC20LimitsTokenConfig,
  XERC20TokenMetadata,
  XERC20Type,
} from './types.js';
import { XERC20_AEVO_ABI } from './xerc20-abi.js';
import { aevoCapToUint256 } from './xerc20-limits.js';

type XERC20LimitsConfig = NonNullable<
  XERC20TokenMetadata['xERC20']
>['warpRouteLimits'];

/**
 * The limits a config declares for a bridge. A Standard or Velodrome entry that
 * leaves out either of its limits is not managed, so it yields none. An Aevo
 * entry is always complete.
 */
function limitsFromConfig(
  config: XERC20LimitsConfig,
): XERC20Limits | undefined {
  switch (config.type) {
    case XERC20Type.Standard:
      return !isNullish(config.mint) && !isNullish(config.burn)
        ? { type: XERC20Type.Standard, mint: config.mint, burn: config.burn }
        : undefined;
    case XERC20Type.Velo:
      return !isNullish(config.bufferCap) &&
        !isNullish(config.rateLimitPerSecond)
        ? {
            type: XERC20Type.Velo,
            bufferCap: config.bufferCap,
            rateLimitPerSecond: config.rateLimitPerSecond,
          }
        : undefined;
    case XERC20Type.Aevo:
      return aevoLimitsFromConfig(config);
    default: {
      const exhaustiveCheck: never = config;
      throw new Error(
        `Unknown xERC20 limits config: ${stringifyObject(exhaustiveCheck, 'json')}`,
      );
    }
  }
}

/**
 * An Aevo entry as the module expects it, with a raw cap written as the decimal
 * string of its value, which is how the reader reports the cap of a minter. The
 * schema writes it that way, but a config it did not parse may spell the same
 * cap otherwise, with leading zeros, and would then differ from what the token
 * holds however often it is applied.
 */
function aevoLimitsFromConfig(config: AevoXERC20Limits): AevoXERC20Limits {
  if (!config.authorized) return config;

  switch (config.cap.type) {
    case XERC20AevoCapType.Unlimited:
      return config;
    case XERC20AevoCapType.Raw:
      return {
        type: XERC20Type.Aevo,
        authorized: true,
        cap: {
          type: XERC20AevoCapType.Raw,
          value: aevoCapToUint256(config.cap).toString(),
        },
      };
    default: {
      const exhaustiveCheck: never = config.cap;
      throw new Error(
        `Unknown Aevo cap: ${stringifyObject(exhaustiveCheck, 'json')}`,
      );
    }
  }
}

const AEVO_INTERFACE = new utils.Interface(XERC20_AEVO_ABI);

/**
 * The counterpart of transferOwnershipTransactions for an Aevo token, which is
 * handed over through its own `setOwner`. That takes effect at once and the new
 * owner accepts nothing, so a transfer to an address that cannot act as owner
 * cannot be undone. The token reverts `setOwner` for the zero address, so its
 * ownership cannot be renounced either, and an expected owner of the zero
 * address is refused instead of emitting a transaction that fails.
 */
export function transferAevoOwnershipTransactions(
  chainId: EvmChainId,
  token: Address,
  actual: OwnableConfig,
  expected: OwnableConfig,
  label?: string,
): AnnotatedEV5Transaction[] {
  if (
    eqAddress(actual.owner, expected.owner) ||
    (isZeroishAddressEvm(actual.owner) && isZeroishAddressEvm(expected.owner))
  ) {
    return [];
  }

  assert(
    !isZeroishAddressEvm(expected.owner),
    `${label ?? token} is an ${XERC20Type.Aevo} token, whose ownership cannot be renounced: its setOwner reverts on the zero address`,
  );

  return [
    {
      chainId,
      annotation: `Transferring ownership of ${label ?? token} from ${
        actual.owner
      } to ${expected.owner} through setOwner, which takes effect at once`,
      to: token,
      data: AEVO_INTERFACE.encodeFunctionData('setOwner', [expected.owner]),
    },
  ];
}

/**
 * Configuration for XERC20 limits management
 */
export interface XERC20ModuleConfig {
  type: XERC20Type;
  limits: XERC20LimitsMap;
  /**
   * Expected owner of the XERC20 token contract (controls limit/bridge mgmt).
   * On a config read this reflects the on-chain owner; on an expected config it
   * drives an ownership-transfer transaction when it differs.
   */
  owner?: Address;
  /**
   * The XERC20 proxy's ProxyAdmin (controls upgrades). On a config read both
   * fields are populated; on an expected config only `owner` is meaningful and
   * `address` may be omitted.
   */
  proxyAdmin?: DeployedOwnableConfig;
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
 * Supports Standard XERC20 (setLimits), Velodrome XERC20 (setBufferCap/addBridge/removeBridge)
 * and Aevo tokens (setCap/updateAuthority).
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

    const [owner, proxyAdmin] = await Promise.all([
      this.reader.readOwner(this.args.addresses.xERC20),
      this.reader.readProxyAdmin(this.args.addresses.xERC20),
    ]);

    return { type, limits, owner, proxyAdmin };
  }

  /**
   * Generate transactions to update XERC20 limits to match expected config.
   * Detects drift and generates correction transactions.
   *
   * Ownership transfers are opt-in via `includeOwnership`. They are only emitted
   * by the dedicated `xerc20 apply` command, where `expectedConfig.owner` is an
   * intentional target for the XERC20 token's `Ownable` owner. The warp
   * deploy/apply path (EvmWarpModule) must NOT enable this: there the warp
   * config `owner` denotes the router owner, not the (often externally-governed)
   * XERC20 token owner, so reconciling it would emit a doomed transferOwnership.
   */
  async update(
    expectedConfig: XERC20ModuleConfig,
    { includeOwnership = false }: { includeOwnership?: boolean } = {},
  ): Promise<AnnotatedEV5Transaction[]> {
    const actualConfig = await this.read();

    assert(
      expectedConfig.type === actualConfig.type,
      `XERC20 type mismatch: expected ${expectedConfig.type} but on-chain is ${actualConfig.type}`,
    );

    const transactions: AnnotatedEV5Transaction[] = [];

    const { missingBridges, extraBridges, limitMismatches } =
      this.detectDriftFromConfigs(expectedConfig, actualConfig);

    for (const bridge of missingBridges) {
      const limits = expectedConfig.limits[bridge];
      if (limits) {
        const txs = await this.generateAddBridgeTxs(bridge, limits);
        transactions.push(...txs);
      }
    }

    for (const { bridge, expected, actual } of limitMismatches) {
      const txs = await this.generateSetLimitsTxs(bridge, expected, actual);
      transactions.push(...txs);
    }

    if (expectedConfig.type === XERC20Type.Velo) {
      for (const bridge of extraBridges) {
        const txs = await this.generateRemoveBridgeTxs(bridge);
        transactions.push(...txs);
      }
    }

    // Ownership transfers are appended LAST so any owner-restricted limit/bridge
    // updates above execute before ownership is handed off.
    if (includeOwnership) {
      transactions.push(
        ...this.generateOwnershipTransferTxs(expectedConfig, actualConfig),
      );
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
   * Generate ownership-transfer transactions for the XERC20 token owner and the
   * proxy's ProxyAdmin owner. No-ops when the expected owner is unset or already
   * matches on-chain state, so callers can apply repeatedly (idempotent).
   */
  protected generateOwnershipTransferTxs(
    expectedConfig: XERC20ModuleConfig,
    actualConfig: XERC20ModuleConfig,
  ): AnnotatedEV5Transaction[] {
    const chainId = this.multiProvider.getEvmChainId(this.chainName);
    const xERC20Address = this.args.addresses.xERC20;
    const transactions: AnnotatedEV5Transaction[] = [];

    // An Aevo token has an owner(), so an owner that reads as none cannot be
    // handed over from, where another type may be a token without one.
    if (expectedConfig.owner && expectedConfig.type === XERC20Type.Aevo) {
      assert(
        actualConfig.owner,
        `Cannot hand over the Aevo token ${xERC20Address} on ${this.chainName} to ${expectedConfig.owner}: it exposes no owner()`,
      );
    }

    if (expectedConfig.owner && actualConfig.owner) {
      const transferTokenOwnership =
        expectedConfig.type === XERC20Type.Aevo
          ? transferAevoOwnershipTransactions
          : transferOwnershipTransactions;
      transactions.push(
        ...transferTokenOwnership(
          chainId,
          xERC20Address,
          { owner: actualConfig.owner },
          { owner: expectedConfig.owner },
          `XERC20 ${xERC20Address}`,
        ),
      );
    }

    if (expectedConfig.proxyAdmin?.owner && actualConfig.proxyAdmin?.address) {
      transactions.push(
        ...transferOwnershipTransactions(
          chainId,
          actualConfig.proxyAdmin.address,
          { owner: actualConfig.proxyAdmin.owner },
          { owner: expectedConfig.proxyAdmin.owner },
          `XERC20 ProxyAdmin ${actualConfig.proxyAdmin.address}`,
        ),
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

      if (actualLimits && limitsMatch(expectedLimits, actualLimits)) {
        continue;
      }

      if (!actualLimits || limitsAreZero(actualLimits)) {
        missingBridges.push(bridge);
        continue;
      }

      limitMismatches.push({
        bridge,
        expected: expectedLimits,
        actual: actualLimits,
      });
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
   *
   * `actual` is what the token holds for the bridge, when it is known, which
   * lets an Aevo minter that is already authorized be changed by its cap alone.
   * Without it, an authorized minter gets the cap and then the authority, and
   * one that is revoked gets the authority alone.
   */
  async generateSetLimitsTxs(
    bridge: Address,
    limits: XERC20Limits,
    actual?: XERC20Limits,
  ): Promise<AnnotatedEV5Transaction[]> {
    const xERC20Address = this.args.addresses.xERC20;
    const chainId = this.multiProvider.getEvmChainId(this.chainName);
    const transactions: AnnotatedEV5Transaction[] = [];

    switch (limits.type) {
      case XERC20Type.Standard: {
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
        break;
      }
      case XERC20Type.Velo: {
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
        break;
      }
      case XERC20Type.Aevo: {
        const adapter = new EvmXERC20AevoAdapter(
          this.chainName,
          this.multiProtocolProvider,
          { token: xERC20Address },
        );

        // A minter that is not authorized is revoked and its cap left alone:
        // the token keeps it and reinstates it when the minter is authorized
        // again, so a cap is always set along with an authority.
        if (!limits.authorized) {
          transactions.push(
            this.annotateTransaction(
              await adapter.populateUpdateAuthorityTx(bridge, false),
              chainId,
              xERC20Address,
            ),
          );
          break;
        }

        // The cap the token keeps for an unauthorized minter is not part of
        // what is read, so it is set whenever a minter is authorized. Set
        // before the authority, so the minter is never authorized with a stale
        // cap. A minter whose authority and cap already match is skipped by
        // the drift check and never gets here.
        transactions.push(
          this.annotateTransaction(
            await adapter.populateSetCapTx(
              bridge,
              aevoCapToUint256(limits.cap),
            ),
            chainId,
            xERC20Address,
          ),
        );
        if (!(actual?.type === XERC20Type.Aevo && actual.authorized)) {
          transactions.push(
            this.annotateTransaction(
              await adapter.populateUpdateAuthorityTx(bridge, true),
              chainId,
              xERC20Address,
            ),
          );
        }
        break;
      }
      default: {
        const exhaustiveCheck: never = limits;
        throw new Error(
          `Unknown xERC20 limits: ${stringifyObject(exhaustiveCheck, 'json')}`,
        );
      }
    }

    return transactions;
  }

  /**
   * Generate transactions to add a bridge.
   * For Standard and Aevo XERC20, equivalent to setting the limits.
   * For Velodrome, uses addBridge function.
   */
  async generateAddBridgeTxs(
    bridge: Address,
    limits: XERC20Limits,
  ): Promise<AnnotatedEV5Transaction[]> {
    switch (limits.type) {
      case XERC20Type.Standard:
      case XERC20Type.Aevo:
        return this.generateSetLimitsTxs(bridge, limits);
      case XERC20Type.Velo:
        return this.generateAddVeloBridgeTxs(bridge, limits);
      default: {
        const exhaustiveCheck: never = limits;
        throw new Error(
          `Unknown xERC20 limits: ${stringifyObject(exhaustiveCheck, 'json')}`,
        );
      }
    }
  }

  protected async generateAddVeloBridgeTxs(
    bridge: Address,
    limits: VeloXERC20Limits,
  ): Promise<AnnotatedEV5Transaction[]> {
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
  ): Promise<AnnotatedEV5Transaction[]> {
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
  ): AnnotatedEV5Transaction {
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
    warpRouteConfig: XERC20LimitsTokenConfig & Partial<OwnableConfig>,
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
      xERC20Address = await lockbox.callStatic.XERC20();
    }

    const limits: XERC20LimitsMap = {};
    const xERC20Config = warpRouteConfig.xERC20;
    const warpRouteLimits = xERC20Config?.warpRouteLimits;

    const declaredWarpRouteLimits =
      warpRouteLimits && limitsFromConfig(warpRouteLimits);
    if (declaredWarpRouteLimits) {
      limits[warpRouteAddress] = declaredWarpRouteLimits;
    }

    for (const {
      lockbox,
      limits: bridgeLimits,
    } of xERC20Config?.extraBridges ?? []) {
      const declaredBridgeLimits = limitsFromConfig(bridgeLimits);
      if (declaredBridgeLimits) {
        limits[lockbox] = declaredBridgeLimits;
      }
    }

    const type: XERC20Type = warpRouteLimits?.type
      ? warpRouteLimits.type
      : await new EvmXERC20Reader(multiProvider, chain).deriveXERC20TokenType(
          xERC20Address,
        );

    // Both the token `Ownable` owner and the ProxyAdmin owner derive from the
    // top-level config `owner`.
    const expectedOwner = warpRouteConfig.owner;

    const config: XERC20ModuleConfig = {
      type,
      limits,
      ...(expectedOwner
        ? { owner: expectedOwner, proxyAdmin: { owner: expectedOwner } }
        : {}),
    };
    const module = new EvmXERC20Module(multiProvider, {
      addresses: { xERC20: xERC20Address, warpRoute: warpRouteAddress },
      chain,
      config,
    });

    return { module, config };
  }
}
