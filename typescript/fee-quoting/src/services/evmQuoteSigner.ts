import type { Logger } from 'pino';
import {
  type Address,
  type Hex,
  type LocalAccount,
  encodePacked,
  isAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  DEFAULT_ROUTER_KEY,
  type DerivedCrossCollateralRoutingFeeConfig,
  type DerivedHookConfig,
  type DerivedRoutingFeeConfig,
  type DerivedTokenFeeConfig,
  type DerivedTokenRouterConfig,
  type EthereumQuoteV2Entry,
  FeeQuotingCommand,
  type HookConfig,
  HookType,
  type IgpHookConfig,
  NoQuoteAvailableReason,
  type SignedQuoteData,
  type SubmitQuoteCommand,
  TokenFeeType,
  WARP_FEE_COMMANDS,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  type WithAddress,
  assert,
  eqAddress,
} from '@hyperlane-xyz/utils';

import { QuoteMode } from '../config.js';
import {
  EIP712_DOMAIN,
  SIGNED_QUOTE_TYPES,
  ZERO_ADDRESS,
} from '../constants.js';
import { ApiError, NoQuoteAvailableError } from '../middleware/errorHandler.js';

import type {
  IProtocolQuoteSigner,
  IgpQuoteRequest,
  QuoteBinding,
  WarpQuoteRequest,
} from './IProtocolQuoteSigner.js';
import type {
  EvmRouterQuoteContext,
  RouterQuoteContext,
} from './quoteService.js';

/**
 * Label for the quoter contract a signed quote applies to. Used in error
 * messages and skip logs to disambiguate the warp/token-fee quoter from the
 * IGP quoter.
 */
const QuoterType = {
  WarpFee: 'warp fee',
  Igp: 'IGP',
} as const;

type QuoterType = (typeof QuoterType)[keyof typeof QuoterType];

/** Args for the EVM-only v1 path (`/quote/*` legacy endpoints). */
export interface V1QuoteArgs {
  command: FeeQuotingCommand;
  origin: string;
  routerCtx: EvmRouterQuoteContext;
  destChainName: string;
  destination: number;
  /** Origin warp router address. */
  router: Address;
  /** Required for warp commands; undefined for ICA commands. */
  recipient?: Hex;
  /** Optional in v1 — the EVM resolver handles missing values gracefully. */
  targetRouter?: Hex;
  binding: QuoteBinding;
}

/**
 * EVM implementation of `IProtocolQuoteSigner`. Signs an EIP-712 typed-data
 * `SignedQuote` struct via viem; routing decisions are driven by the on-chain
 * config tree decoded by `EvmWarpRouteReader` / `EvmHookReader` and stored on
 * each `EvmRouterQuoteContext`.
 *
 * Also exposes `getV1Quotes(...)` — an EVM-only entry point that powers the
 * legacy v1 `/quote/*` routes (command-aware, multi-quote, silently logs on
 * skip rather than throwing). v1 was always EVM-only, so this lives on the
 * concrete class rather than the protocol-agnostic interface.
 */
export class EvmQuoteSigner implements IProtocolQuoteSigner {
  readonly protocol = ProtocolType.Ethereum;
  private readonly account: LocalAccount;
  private readonly logger: Logger;

  constructor(opts: { signerKey: Hex; logger: Logger }) {
    this.account = privateKeyToAccount(opts.signerKey);
    this.logger = opts.logger;
  }

  get signerAddress(): Address {
    return this.account.address;
  }

  // ============ v2 interface ============

  async getWarpQuote(req: WarpQuoteRequest): Promise<EthereumQuoteV2Entry> {
    const ctx = this.requireEvmCtx(req.routerCtx);
    const feeQuoter = this.resolveOffchainFeeLeaf(
      ctx.derivedConfig.tokenFee,
      req.destChainName,
      req.targetRouter,
    );
    return this.signWarpQuote(
      ctx,
      feeQuoter,
      req.destination,
      req.recipient,
      req.binding,
    );
  }

  async getIgpQuote(req: IgpQuoteRequest): Promise<EthereumQuoteV2Entry> {
    const ctx = this.requireEvmCtx(req.routerCtx);
    if (!isAddress(req.sender)) {
      throw new ApiError(`Invalid EVM sender address: ${req.sender}`, 400);
    }
    const igp = this.resolveIgp(ctx.derivedConfig, req.destChainName);
    return this.signIgpQuote(
      ctx,
      igp,
      ctx.feeToken,
      req.destination,
      req.sender,
      req.binding,
    );
  }

  // ============ v1 EVM-only entry point ============

  async getV1Quotes(args: V1QuoteArgs): Promise<SubmitQuoteCommand[]> {
    const quotes: SubmitQuoteCommand[] = [];

    if (WARP_FEE_COMMANDS.has(args.command)) {
      assert(args.recipient, `recipient required for ${args.command}`);
      try {
        const feeQuoter = this.resolveOffchainFeeLeaf(
          args.routerCtx.derivedConfig.tokenFee,
          args.destChainName,
          args.targetRouter,
        );
        const entry = await this.signWarpQuote(
          args.routerCtx,
          feeQuoter,
          args.destination,
          args.recipient,
          args.binding,
        );
        quotes.push(toSubmitQuoteCommand(entry));
      } catch (err) {
        this.logSkipIfExpected(QuoterType.WarpFee, err, args);
      }
    }

    try {
      const igp = this.resolveIgp(
        args.routerCtx.derivedConfig,
        args.destChainName,
      );
      const entry = await this.signIgpQuote(
        args.routerCtx,
        igp,
        args.routerCtx.feeToken,
        args.destination,
        args.router,
        args.binding,
      );
      quotes.push(toSubmitQuoteCommand(entry));
    } catch (err) {
      this.logSkipIfExpected(QuoterType.Igp, err, args);
    }

    return quotes;
  }

  // ============ private: resolve ============

  /**
   * Walks the fee tree to find the leaf `OffchainQuotedLinearFee` that
   * applies to `(destChainName, targetRouter)`, asserts this signer is
   * whitelisted on it, and returns the verifying contract address. Throws
   * `NoQuoteAvailableError` on miss. `OffchainQuotedLinearFee` is the only
   * on-chain fee variant that extends `AbstractOffchainQuoter`, so it's the
   * only variant that carries `quoteSigners`.
   */
  private resolveOffchainFeeLeaf(
    tokenFee: DerivedTokenFeeConfig | undefined,
    destChainName: string,
    targetRouter?: Hex,
  ): Address {
    if (!tokenFee) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotConfigured,
        `No tokenFee configured for ${destChainName}`,
      );
    }

    const leaf = pickFeeLeaf(tokenFee, destChainName, targetRouter);
    if (leaf.type !== TokenFeeType.OffchainQuotedLinearFee) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotUpgraded,
        `Fee at ${leaf.address} is ${leaf.type}, not OffchainQuotedLinearFee`,
      );
    }
    this.assertSignerAuthorized(
      leaf.quoteSigners,
      leaf.address,
      QuoterType.WarpFee,
    );
    return narrowAddress(leaf.address, 'warp fee quoter');
  }

  /** Walks the hook tree to find the destination's IGP address. */
  private resolveIgp(
    config: DerivedTokenRouterConfig,
    destChainName: string,
  ): Address {
    if (typeof config.hook === 'string') {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotConfigured,
        `Hook on origin is an opaque address — derived config required`,
      );
    }
    const igp = findIgpForDestination(config.hook, destChainName);
    if (!igp) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotConfigured,
        `No IGP hook configured for ${destChainName}`,
      );
    }
    this.assertSignerAuthorized(igp.quoteSigners, igp.address, QuoterType.Igp);
    return narrowAddress(igp.address, QuoterType.Igp);
  }

  private assertSignerAuthorized(
    signers: string[] | undefined,
    quoter: string,
    quoterType: QuoterType,
  ): void {
    if (!signers || signers.length === 0) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotUpgraded,
        `${quoterType} quoter ${quoter} has no quoteSigners — not upgraded to offchain quoting`,
      );
    }
    if (!signers.some((s) => eqAddress(s, this.account.address))) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotAuthorized,
        `Server signer ${this.account.address} not in ${quoterType} quoter ${quoter} quoteSigners`,
      );
    }
  }

  // ============ private: sign ============

  private async signWarpQuote(
    ctx: EvmRouterQuoteContext,
    feeQuoter: Address,
    destination: number,
    recipient: Hex,
    binding: QuoteBinding,
  ): Promise<EthereumQuoteV2Entry> {
    const context = encodePacked(
      ['uint32', 'bytes32', 'uint256'],
      [destination, recipient, BigInt(2) ** BigInt(256) - BigInt(1)],
    );
    const data = encodePacked(['uint256', 'uint256'], [0n, 1n]);
    return this.signEip712(ctx, feeQuoter, context, data, binding);
  }

  private async signIgpQuote(
    ctx: EvmRouterQuoteContext,
    igp: Address,
    feeToken: Address,
    destination: number,
    sender: Address,
    binding: QuoteBinding,
  ): Promise<EthereumQuoteV2Entry> {
    const context = encodePacked(
      ['address', 'uint32', 'address'],
      [feeToken, destination, sender],
    );
    const data = encodePacked(['uint128', 'uint128'], [0n, 0n]);
    return this.signEip712(ctx, igp, context, data, binding);
  }

  private async signEip712(
    ctx: EvmRouterQuoteContext,
    verifyingContract: Address,
    context: Hex,
    data: Hex,
    binding: QuoteBinding,
  ): Promise<EthereumQuoteV2Entry> {
    const now = Math.floor(Date.now() / 1000);
    // Transient: issuedAt = expiry = now + buffer (sentinel for transient
    // storage). The buffer ensures block.timestamp <= expiry when the tx
    // lands. Standing: issuedAt = now, expiry = now + ttlSeconds.
    const issuedAt =
      binding.kind === QuoteMode.TRANSIENT
        ? now + binding.transientBuffer
        : now;
    const expiry =
      binding.kind === QuoteMode.TRANSIENT
        ? issuedAt
        : now + binding.ttlSeconds;

    // Transient binding pins the on-chain submitter to QuotedCalls (front-run
    // protection); standing leaves it open via address(0).
    const submitter =
      binding.kind === QuoteMode.TRANSIENT
        ? ctx.quotedCallsAddress
        : ZERO_ADDRESS;

    const quote: SignedQuoteData = {
      context,
      data,
      issuedAt,
      expiry,
      salt: binding.salt,
      submitter,
    };

    const signature = await this.account.signTypedData({
      domain: { ...EIP712_DOMAIN, chainId: ctx.chainId, verifyingContract },
      types: SIGNED_QUOTE_TYPES,
      primaryType: 'SignedQuote',
      message: quote,
    });

    return {
      protocol: ProtocolType.Ethereum,
      quoter: verifyingContract,
      issuedAt,
      expiry,
      details: { quote, signature },
    };
  }

  // ============ helpers ============

  private requireEvmCtx(ctx: RouterQuoteContext): EvmRouterQuoteContext {
    assert(
      ctx.protocol === ProtocolType.Ethereum,
      `EvmQuoteSigner expected an Ethereum router context, got ${ctx.protocol}`,
    );
    return ctx;
  }

  private logSkipIfExpected(
    quoterType: QuoterType,
    err: unknown,
    args: V1QuoteArgs,
  ): void {
    if (!(err instanceof NoQuoteAvailableError)) throw err;
    const ctx = {
      origin: args.origin,
      router: args.router,
      destination: args.destChainName,
      quoterType,
      reason: err.reason,
    };
    if (err.reason === NoQuoteAvailableReason.NotAuthorized) {
      this.logger.warn(ctx, `Skipping ${quoterType} quote: ${err.detail}`);
    } else {
      this.logger.debug(ctx, `Skipping ${quoterType} quote: ${err.detail}`);
    }
  }
}

// ============ standalone walkers (pure functions, no this) ============

/**
 * Walks down a fee tree, unwrapping `RoutingFee` / `CrossCollateralRoutingFee`
 * layers to find the leaf fee config for `(destChainName, targetRouter)`.
 * Returns the input itself if no matching destination — caller decides if
 * that's an error.
 */
function pickFeeLeaf(
  fee: DerivedTokenFeeConfig,
  destChainName: string,
  targetRouter?: Hex,
): DerivedTokenFeeConfig {
  switch (fee.type) {
    case TokenFeeType.RoutingFee: {
      // SDK's static narrowing widens `feeContracts` after the type discriminant;
      // the reader populates the `DerivedRoutingFeeConfig` shape at runtime.
      const routing = fee as DerivedRoutingFeeConfig;
      const destFee = routing.feeContracts[destChainName];
      return destFee ? pickFeeLeaf(destFee, destChainName, targetRouter) : fee;
    }
    case TokenFeeType.CrossCollateralRoutingFee: {
      const cc = fee as DerivedCrossCollateralRoutingFeeConfig;
      const destConfig = cc.feeContracts[destChainName];
      if (!destConfig) return fee;
      const exact = targetRouter ? destConfig[targetRouter] : undefined;
      const resolved = exact ?? destConfig[DEFAULT_ROUTER_KEY];
      return resolved
        ? pickFeeLeaf(resolved, destChainName, targetRouter)
        : fee;
    }
    default:
      return fee;
  }
}

/**
 * Walks a hook tree looking for the IGP that applies to `destChainName`.
 * Handles routing/fallback-routing unwrapping and aggregation recursion in a
 * single pass. Returns the typed IGP node (with `.address`) or undefined.
 */
function findIgpForDestination(
  hook: DerivedHookConfig | Address,
  destChainName: string,
): WithAddress<IgpHookConfig> | undefined {
  if (typeof hook === 'string') return undefined;

  switch (hook.type) {
    case HookType.INTERCHAIN_GAS_PAYMASTER:
      return hook;
    case HookType.AGGREGATION: {
      for (const child of hook.hooks) {
        const found = findIgpForDestination(
          bridgeDerivedHook(child),
          destChainName,
        );
        if (found) return found;
      }
      return undefined;
    }
    case HookType.ROUTING:
    case HookType.FALLBACK_ROUTING: {
      const destHook = hook.domains[destChainName];
      if (destHook) {
        return findIgpForDestination(
          bridgeDerivedHook(destHook),
          destChainName,
        );
      }
      if (hook.type === HookType.FALLBACK_ROUTING) {
        return findIgpForDestination(
          bridgeDerivedHook(hook.fallback),
          destChainName,
        );
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * SDK widening bridge: `RoutingHookConfig.domains[X]` / `AggregationHookConfig.hooks[i]`
 * are typed as the base `HookConfig`, but `EvmHookReader` recursively populates
 * every level as `DerivedHookConfig | Address` at runtime. This helper bridges
 * the static gap without spraying casts at each recursion site.
 */
function bridgeDerivedHook(v: HookConfig): DerivedHookConfig | Address {
  return v as DerivedHookConfig | Address;
}

/** Repack an EVM v2 entry into the v1 `SubmitQuoteCommand` wire shape. */
function toSubmitQuoteCommand(entry: EthereumQuoteV2Entry): SubmitQuoteCommand {
  return {
    quoter: narrowAddress(entry.quoter, 'v2 entry quoter'),
    quote: entry.details.quote,
    signature: entry.details.signature,
  };
}

/** Narrow a `string` (utils `Address`) to viem's strict `\`0x${string}\``. */
function narrowAddress(value: string, label: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid EVM address for ${label}: ${value}`);
  }
  return value;
}
