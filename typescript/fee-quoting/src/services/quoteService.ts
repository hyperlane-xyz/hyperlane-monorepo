import type { Logger } from 'pino';
import type { Counter } from 'prom-client';
import { type Address, type Hex, type LocalAccount, encodePacked } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { deepFind, eqAddress } from '@hyperlane-xyz/utils';
import type { WithAddress } from '@hyperlane-xyz/utils';
import {
  type DerivedTokenRouterConfig,
  type HookConfig,
  type IgpHookConfig,
  type MultiProvider,
  HookType,
} from '@hyperlane-xyz/sdk';
import { TokenFeeType } from '@hyperlane-xyz/sdk';
import type { DerivedTokenFeeConfig } from '@hyperlane-xyz/sdk';

import type { QuoteMode } from '../config.js';
import {
  EIP712_DOMAIN,
  SIGNED_QUOTE_TYPES,
  ZERO_ADDRESS,
} from '../constants.js';
import { ApiError } from '../middleware/errorHandler.js';
import {
  type QuoteResponse,
  type SignedQuoteData,
  type SubmitQuoteCommand,
  QuotedCallsCommand,
  WARP_FEE_COMMANDS,
} from '../types.js';

/** Per-router config derived from on-chain state */
export interface RouterQuoteContext {
  feeToken: Address;
  derivedConfig: DerivedTokenRouterConfig;
}

/** Per-chain context shared across all routers on that chain */
export interface ChainQuoteContext {
  chainId: number;
  domainId: number;
  chainName: string;
  quotedCallsAddress: Address;
  multiProvider: MultiProvider;
  routers: Map<Address, RouterQuoteContext>;
}

export interface QuoteServiceOptions {
  signerKey: Hex;
  quoteMode: QuoteMode;
  quoteExpiry: number;
  chainContexts: Map<string, ChainQuoteContext>;
  logger: Logger;
  quotesServed?: Counter;
}

export class QuoteService {
  private readonly account: LocalAccount;
  private readonly quoteMode: QuoteMode;
  private readonly quoteExpiry: number;
  private readonly chainContexts: Map<string, ChainQuoteContext>;
  private readonly logger: Logger;
  private readonly quotesServed?: Counter;

  constructor(options: QuoteServiceOptions) {
    this.account = privateKeyToAccount(options.signerKey);
    this.quoteMode = options.quoteMode;
    this.quoteExpiry = options.quoteExpiry;
    this.chainContexts = options.chainContexts;
    this.logger = options.logger;
    this.quotesServed = options.quotesServed;
  }

  get signerAddress(): Address {
    return this.account.address;
  }

  getChainContext(origin: string): ChainQuoteContext | undefined {
    return this.chainContexts.get(origin);
  }

  /**
   * Generate signed quotes for a QuotedCalls command.
   *
   * In transient mode: requires sender, generates clientSalt, scopes quotes to caller.
   * In standing mode: no sender needed, quotes are reusable until expiry.
   */
  async getQuote(
    origin: string,
    command: QuotedCallsCommand,
    router: Address,
    destination: number,
    salt: Hex,
    recipient?: Hex,
    targetRouter?: Hex,
  ): Promise<QuoteResponse> {
    const ctx = this.chainContexts.get(origin);
    if (!ctx) {
      throw new ApiError(`Unknown origin chain: ${origin}`, 400);
    }

    const routerCtx = ctx.routers.get(router);
    if (!routerCtx) {
      throw new ApiError(`Unknown router ${router} on ${origin}`, 400);
    }

    // Mode controls expiry and submitter:
    //   transient → expiry == issuedAt, submitter = QuotedCalls (prevents front-running)
    //   standing  → expiry  > issuedAt, submitter = address(0) (unrestricted)
    const binding: QuoteBinding = {
      salt,
      submitter:
        this.quoteMode === 'transient' ? ctx.quotedCallsAddress : ZERO_ADDRESS,
      expiry: this.quoteMode === 'transient' ? 'transient' : this.quoteExpiry,
      transientBuffer: DEFAULT_TRANSIENT_BUFFER_SECONDS,
    };

    const destChainName = ctx.multiProvider.getChainName(destination);
    const quotePromises: Promise<SubmitQuoteCommand>[] = [];

    if (WARP_FEE_COMMANDS.has(command)) {
      if (!recipient) {
        throw new ApiError(`recipient required for ${command}`, 400);
      }
      const feeResult = resolveFeeQuoter(
        routerCtx.derivedConfig,
        destChainName,
        this.account.address,
        targetRouter,
      );
      if ('address' in feeResult) {
        quotePromises.push(
          this.signWarpFeeQuote(
            ctx,
            feeResult.address as Address,
            destination,
            recipient,
            binding,
          ),
        );
      } else {
        this.logSkipped(
          'warp fee',
          feeResult.skipped,
          origin,
          router,
          destChainName,
        );
      }
    }

    const igpResult = resolveIgp(
      routerCtx.derivedConfig,
      destChainName,
      this.account.address,
    );
    if ('address' in igpResult) {
      quotePromises.push(
        this.signIgpQuote(
          ctx,
          igpResult.address as Address,
          routerCtx.feeToken,
          destination,
          router,
          binding,
        ),
      );
    } else {
      this.logSkipped('IGP', igpResult.skipped, origin, router, destChainName);
    }

    const quotes = await Promise.all(quotePromises);

    const dest = String(destination);
    for (const q of quotes) {
      this.quotesServed?.inc({
        origin,
        command,
        router,
        destination: dest,
        quoter: q.quoter,
      });
    }

    this.logger.info(
      {
        origin,
        command,
        router,
        destination,
        quoters: quotes.map((q) => q.quoter),
        mode: this.quoteMode,
      },
      'Generated signed quotes',
    );

    return { quotes };
  }

  private logSkipped(
    quoterType: string,
    reason: 'not_configured' | 'not_upgraded' | 'not_authorized',
    origin: string,
    router: Address,
    destination: string,
  ): void {
    const ctx = { origin, router, destination, quoterType: quoterType };
    if (reason === 'not_authorized') {
      this.logger.warn(
        ctx,
        `Skipping ${quoterType} quote: signer not in quoteSigners`,
      );
    } else {
      this.logger.debug(
        ctx,
        `Skipping ${quoterType} quote: ${reason === 'not_configured' ? 'not configured' : 'contract not upgraded'}`,
      );
    }
  }

  private async signWarpFeeQuote(
    ctx: ChainQuoteContext,
    feeQuoter: Address,
    destination: number,
    recipient: Hex,
    binding: QuoteBinding,
  ): Promise<SubmitQuoteCommand> {
    const context = encodePacked(
      ['uint32', 'bytes32', 'uint256'],
      [destination, recipient, BigInt(2) ** BigInt(256) - BigInt(1)],
    );
    const data = encodePacked(['uint256', 'uint256'], [0n, 1n]);

    const { quote, signature } = await this.signQuote(
      ctx.chainId,
      feeQuoter,
      context,
      data,
      binding,
    );
    return { quoter: feeQuoter, quote, signature };
  }

  private async signIgpQuote(
    ctx: ChainQuoteContext,
    igp: Address,
    feeToken: Address,
    destination: number,
    sender: Address,
    binding: QuoteBinding,
  ): Promise<SubmitQuoteCommand> {
    const context = encodePacked(
      ['address', 'uint32', 'address'],
      [feeToken, destination, sender],
    );
    const data = encodePacked(['uint128', 'uint128'], [0n, 0n]);

    const { quote, signature } = await this.signQuote(
      ctx.chainId,
      igp,
      context,
      data,
      binding,
    );
    return { quoter: igp, quote, signature };
  }

  private async signQuote(
    chainId: number,
    verifyingContract: Address,
    context: Hex,
    data: Hex,
    binding: QuoteBinding,
  ): Promise<{ quote: SignedQuoteData; signature: Hex }> {
    const now = Math.floor(Date.now() / 1000);
    // Transient: issuedAt = expiry = now + buffer (sentinel for transient storage).
    // The buffer ensures block.timestamp <= expiry when the tx lands.
    // Standing: issuedAt = now, expiry = now + TTL.
    const issuedAt =
      binding.expiry === 'transient' ? now + binding.transientBuffer : now;
    const expiry =
      binding.expiry === 'transient' ? issuedAt : now + binding.expiry;

    const quote: SignedQuoteData = {
      context,
      data,
      issuedAt,
      expiry,
      salt: binding.salt,
      submitter: binding.submitter,
    };

    const signature = await this.account.signTypedData({
      domain: {
        ...EIP712_DOMAIN,
        chainId: BigInt(chainId),
        verifyingContract,
      },
      types: SIGNED_QUOTE_TYPES,
      primaryType: 'SignedQuote',
      message: {
        context: quote.context,
        data: quote.data,
        issuedAt: quote.issuedAt,
        expiry: quote.expiry,
        salt: quote.salt,
        submitter: quote.submitter,
      },
    });

    return { quote, signature };
  }
}

/** Default transient buffer in seconds (5 minutes for testing) */
const DEFAULT_TRANSIENT_BUFFER_SECONDS = 300;

/** Salt/submitter/expiry binding for a quote */
interface QuoteBinding {
  salt: Hex;
  submitter: Address;
  /** 'transient' = expiry equals issuedAt; number = standing TTL in seconds */
  expiry: 'transient' | number;
  /** Buffer in seconds for transient quotes (derived from block time) */
  transientBuffer: number;
}

// ============ Config traversal ============

type ResolveResult =
  | { address: string }
  | { skipped: 'not_configured' | 'not_upgraded' | 'not_authorized' };

function checkSignerAuthorized(
  signers: string[] | undefined,
  signer: Address,
): 'not_configured' | 'not_upgraded' | 'not_authorized' | undefined {
  if (!signers) return 'not_upgraded';
  if (signers.length === 0) return 'not_upgraded';
  if (!signers.some((s) => eqAddress(s, signer))) return 'not_authorized';
  return undefined;
}

function resolveFeeQuoter(
  config: DerivedTokenRouterConfig,
  destChainName: string,
  signer: Address,
  targetRouter?: Hex,
): ResolveResult {
  const tokenFee = config.tokenFee;
  if (!tokenFee) return { skipped: 'not_configured' };

  let resolved = tokenFee;
  if (tokenFee.type === TokenFeeType.RoutingFee && tokenFee.feeContracts) {
    const destFee = tokenFee.feeContracts[destChainName] as
      | DerivedTokenFeeConfig
      | undefined;
    if (destFee) resolved = destFee;
  } else if (
    tokenFee.type === TokenFeeType.CrossCollateralRoutingFee &&
    tokenFee.feeContracts
  ) {
    const destConfig = tokenFee.feeContracts[destChainName] as
      | {
          default?: DerivedTokenFeeConfig;
          routers?: Record<string, DerivedTokenFeeConfig>;
        }
      | undefined;
    if (destConfig) {
      // For transferRemoteTo, resolve the router-specific fee contract
      const routerFee = targetRouter
        ? destConfig.routers?.[targetRouter]
        : undefined;
      // Fall back to default fee contract
      resolved = routerFee ?? destConfig.default ?? resolved;
    }
  }

  const signers =
    'quoteSigners' in resolved
      ? (resolved.quoteSigners as string[] | undefined)
      : undefined;
  const reason = checkSignerAuthorized(signers, signer);
  if (reason) return { skipped: reason };

  return { address: resolved.address };
}

function resolveIgp(
  config: DerivedTokenRouterConfig,
  destChainName: string,
  signer: Address,
): ResolveResult {
  const hook = config.hook;
  if (typeof hook === 'string') return { skipped: 'not_configured' };

  let searchRoot: Exclude<HookConfig, string> = hook;
  if (
    hook.type === HookType.ROUTING ||
    hook.type === HookType.FALLBACK_ROUTING
  ) {
    const destHook = hook.domains[destChainName];
    if (destHook && typeof destHook !== 'string') {
      searchRoot = destHook;
    } else if (hook.type === HookType.FALLBACK_ROUTING && hook.fallback) {
      if (typeof hook.fallback !== 'string') {
        searchRoot = hook.fallback;
      }
    }
  }

  const igp = deepFind(
    searchRoot as object,
    (v): v is WithAddress<IgpHookConfig> =>
      typeof v === 'object' &&
      v !== null &&
      'type' in v &&
      v.type === HookType.INTERCHAIN_GAS_PAYMASTER &&
      'address' in v,
  );

  if (!igp) return { skipped: 'not_configured' };

  const reason = checkSignerAuthorized(igp.quoteSigners, signer);
  if (reason) return { skipped: reason };

  return { address: igp.address };
}
