import type { Logger } from 'pino';
import { type Hex, bytesToHex, hexToBytes } from 'viem';

import {
  type ChainMetadataForAltVM,
  ProtocolType,
  getProtocolProvider,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import {
  type FeeArtifactConfig,
  type FeeStrategy,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import {
  DEFAULT_ROUTER_KEY,
  type MultiProvider,
  NoQuoteAvailableReason,
  type SealevelQuoteV2Entry,
} from '@hyperlane-xyz/sdk';
import {
  FeeStrategyKind,
  SealevelProtocolProvider,
  type SvmFeeQuoteContextInput,
  type SvmSignedQuote,
  WILDCARD_AMOUNT,
  encodeFeeDataStrategy,
  encodeSvmFeeQuoteContext,
  encodeSvmIgpQuoteContext,
  encodeSvmIgpQuoteData,
  ethAddressHexFromPrivateKey,
  isSealevelDeployedIgpHook,
  isSealevelDeployedWarpAddress,
  signSvmQuote,
} from '@hyperlane-xyz/sealevel-sdk';
import { eqAddress } from '@hyperlane-xyz/utils';

import { QuoteMode } from '../config.js';
import { ApiError, NoQuoteAvailableError } from '../middleware/errorHandler.js';

import {
  type IProtocolQuoteService,
  type IgpQuoteRequest,
  type QuoteBinding,
  QuoterType,
  type WarpQuoteRequest,
} from './IProtocolQuoteService.js';
import {
  PLACEHOLDER_IGP_PRICING,
  PLACEHOLDER_WARP_FEE_PARAMS,
} from './quotePolicy.js';

/**
 * `Pubkey::default()` in base58. The on-chain SVM IGP `submit_quote` rejects
 * any non-default `fee_token_mint` (`NonDefaultFeeTokenMint`), so SOL-native
 * fee tokens are the only flavor it accepts today. The encoder slot stays
 * exposed so the SDK is forward-compatible if the restriction is lifted.
 */
const NATIVE_FEE_TOKEN_MINT = '11111111111111111111111111111111';

/** Per-route on-chain state snapshot. Fee config tree is walked per request
 * (mirrors EVM); IGP signers are snapshot once and not refreshed mid-flight.
 *
 * Exported so tests can construct route states directly via `fromState`
 * without going through the on-chain artifact read path. */
export interface SvmRouteState {
  domainId: number;
  warpProgramId: string;
  fee?: {
    feeAccountPda: string;
    config: FeeArtifactConfig;
  };
  igp?: {
    igpAccountPda: string;
    signers: string[];
  };
}

/** Per-route input to `SvmQuoteService.create` (post warp-config partitioning). */
export interface SvmRouteSpec {
  origin: string;
  domainId: number;
  warpProgramId: string;
  chainMetadata: ChainMetadataForAltVM;
}

const routeKey = (origin: string, router: string) => `${origin}:${router}`;

/**
 * Sealevel implementation of `IProtocolQuoteService`. Owns its protocol stack:
 * reads warp + fee + IGP-hook artifacts at construction via the Sealevel
 * `ProtocolProvider`, caches per-route state, and signs raw-keccak256
 * `SvmSignedQuote` envelopes via secp256k1.
 *
 * v1 (`/quote/*`) is intentionally EVM-only by contract — Sealevel routes are
 * only reachable through v2's dispatch on `QuoteService`.
 */
export class SvmQuoteService implements IProtocolQuoteService {
  readonly protocol = ProtocolType.Sealevel;
  private readonly privateKey: Uint8Array;
  private readonly signerH160: string;
  private readonly logger: Logger;
  private readonly routesByKey: ReadonlyMap<string, SvmRouteState>;

  private constructor(opts: {
    privateKey: Uint8Array;
    signerH160: string;
    logger: Logger;
    routesByKey: ReadonlyMap<string, SvmRouteState>;
  }) {
    this.privateKey = opts.privateKey;
    this.signerH160 = opts.signerH160;
    this.logger = opts.logger;
    this.routesByKey = opts.routesByKey;
    this.logger.info(
      {
        signer: opts.signerH160,
        routes: [...opts.routesByKey.keys()],
      },
      'SvmQuoteService initialized',
    );
  }

  /**
   * Async factory — reads each route's on-chain state once via the Sealevel
   * `ProtocolProvider`. Mid-flight signer rotation will not be picked up
   * until restart, matching EVM's snapshot semantics.
   */
  static async create(opts: {
    signerKey: Uint8Array;
    logger: Logger;
    multiProvider: MultiProvider;
    routes: ReadonlyArray<SvmRouteSpec>;
  }): Promise<SvmQuoteService> {
    ensureSealevelProtocolRegistered();
    const provider = getProtocolProvider(ProtocolType.Sealevel);

    const routesByKey = new Map<string, SvmRouteState>();
    for (const r of opts.routes) {
      const state = await readSvmRouteState(provider, r, opts.logger);
      routesByKey.set(routeKey(r.origin, r.warpProgramId), state);
    }

    return new SvmQuoteService({
      privateKey: opts.signerKey,
      signerH160: ethAddressHexFromPrivateKey(opts.signerKey),
      logger: opts.logger,
      routesByKey,
    });
  }

  /**
   * Testing-only constructor — accepts pre-built route states directly,
   * bypassing the on-chain reads in `create`. Use only from tests that
   * already mock `FeeArtifactConfig` shapes + IGP-signer sets.
   */
  static fromState(opts: {
    signerKey: Uint8Array;
    logger: Logger;
    routes: ReadonlyArray<
      {
        origin: string;
      } & SvmRouteState
    >;
  }): SvmQuoteService {
    const routesByKey = new Map<string, SvmRouteState>();
    for (const r of opts.routes) {
      routesByKey.set(routeKey(r.origin, r.warpProgramId), {
        domainId: r.domainId,
        warpProgramId: r.warpProgramId,
        fee: r.fee,
        igp: r.igp,
      });
    }
    return new SvmQuoteService({
      privateKey: opts.signerKey,
      signerH160: ethAddressHexFromPrivateKey(opts.signerKey),
      logger: opts.logger,
      routesByKey,
    });
  }

  hasRoute(origin: string, router: string): boolean {
    return this.routesByKey.has(routeKey(origin, router));
  }

  // ============ v2 interface ============

  async getWarpQuote(req: WarpQuoteRequest): Promise<SealevelQuoteV2Entry> {
    const route = this.lookupRoute(req.origin, req.router);
    if (!route.fee) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotConfigured,
        `No fee program configured for ${req.origin}/${req.router}`,
      );
    }

    const resolved = resolveSvmWarpQuote(
      route.fee.config,
      req.destination,
      hexToBytes(req.recipient),
      hexToBytes(req.targetRouter),
      route.fee.feeAccountPda,
    );
    this.assertSignerAuthorized(
      resolved.quoteSigners,
      route.fee.feeAccountPda,
      QuoterType.WarpFee,
    );

    const context = encodeSvmFeeQuoteContext(resolved.contextInput);
    // Strategy variant must match on-chain leaf. TS only models
    // OffchainQuotedLinear → Linear; future curves widen this switch. Params
    // are placeholders → fee=0; deployment-level policy overrides if dynamic
    // pricing is needed.
    const data = encodeFeeDataStrategy({
      kind: FeeStrategyKind.Linear,
      params: PLACEHOLDER_WARP_FEE_PARAMS,
    });

    return this.signAndShape({
      quoter: route.fee.feeAccountPda,
      domainId: route.domainId,
      context: Uint8Array.from(context),
      data: Uint8Array.from(data),
      binding: req.binding,
      txSubmitter: req.txSubmitter,
    });
  }

  async getIgpQuote(req: IgpQuoteRequest): Promise<SealevelQuoteV2Entry> {
    const route = this.lookupRoute(req.origin, req.router);
    if (!route.igp) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotConfigured,
        `No IGP hook configured for ${req.origin}/${req.router}`,
      );
    }
    this.assertSignerAuthorized(
      route.igp.signers,
      route.igp.igpAccountPda,
      QuoterType.Igp,
    );

    const context = encodeSvmIgpQuoteContext({
      feeTokenMint: NATIVE_FEE_TOKEN_MINT,
      destinationDomain: req.destination,
      sender: req.sender,
    });
    // Placeholder pricing → fee=0 on-chain, mirroring EVM's `(0, 0)` IGP
    // placeholder. Real pricing is set by oracles, not the offchain quoter.
    const data = encodeSvmIgpQuoteData(PLACEHOLDER_IGP_PRICING);

    return this.signAndShape({
      quoter: route.igp.igpAccountPda,
      domainId: route.domainId,
      context: Uint8Array.from(context),
      data: Uint8Array.from(data),
      binding: req.binding,
      txSubmitter: req.txSubmitter,
    });
  }

  // ============ private helpers ============

  private lookupRoute(origin: string, router: string): SvmRouteState {
    const route = this.routesByKey.get(routeKey(origin, router));
    if (!route) {
      throw new ApiError(`Unknown router ${router} on ${origin}`, 400);
    }
    return route;
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
    if (!signers.some((s) => eqAddress(s, this.signerH160))) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotAuthorized,
        `Server signer ${this.signerH160} not in ${quoterType} quoter ${quoter} quoteSigners`,
      );
    }
  }

  private signAndShape(args: {
    quoter: string;
    domainId: number;
    context: Uint8Array;
    data: Uint8Array;
    binding: QuoteBinding;
    txSubmitter: string;
  }): SealevelQuoteV2Entry {
    const { issuedAt, expiry } = resolveTimestamps(args.binding);
    const signed = signSvmQuote({
      privateKey: this.privateKey,
      feeAccount: args.quoter,
      domainId: args.domainId,
      payer: args.txSubmitter,
      context: args.context,
      data: args.data,
      issuedAt,
      expiry,
      clientSalt: hexToBytes(args.binding.salt),
    });

    return shapeEntry({
      quoter: args.quoter,
      domainId: args.domainId,
      issuedAt: Number(issuedAt),
      expiry: Number(expiry),
      signed,
    });
  }
}

// ============ Sealevel protocol registration ============

function ensureSealevelProtocolRegistered(): void {
  if (!hasProtocol(ProtocolType.Sealevel)) {
    registerProtocol(
      ProtocolType.Sealevel,
      () => new SealevelProtocolProvider(),
    );
  }
}

// ============ per-route artifact reads ============

/**
 * Reads warp + fee + IGP hook artifacts for a single SVM route via the
 * Sealevel `ProtocolProvider`. Failures in sub-reads degrade gracefully
 * (mirroring EVM's tolerant resolve): a half-configured route can still
 * answer the half of v2 that's wired up.
 */
async function readSvmRouteState(
  provider: ReturnType<typeof getProtocolProvider>,
  spec: SvmRouteSpec,
  logger: Logger,
): Promise<SvmRouteState> {
  const warpMgr = provider.createWarpArtifactManager(spec.chainMetadata);
  const warpArtifact = await warpMgr.readWarpToken(spec.warpProgramId);

  let fee: SvmRouteState['fee'] | undefined;
  if (isSealevelDeployedWarpAddress(warpArtifact.deployed)) {
    const feeConfig = warpArtifact.deployed.feeConfig;
    if (feeConfig) {
      fee = await tryReadSvmFee(
        provider,
        spec,
        feeConfig.feeProgram,
        feeConfig.feeAccount,
        logger,
      );
    }
  }

  const hookProgramId = warpArtifact.config.hook?.deployed.address;
  const igp = hookProgramId
    ? await tryReadSvmIgp(provider, spec, hookProgramId, logger)
    : undefined;

  return {
    domainId: spec.domainId,
    warpProgramId: spec.warpProgramId,
    fee,
    igp,
  };
}

async function tryReadSvmFee(
  provider: ReturnType<typeof getProtocolProvider>,
  spec: SvmRouteSpec,
  feeProgram: string,
  feeAccountPda: string,
  logger: Logger,
): Promise<SvmRouteState['fee'] | undefined> {
  const ctx = { knownRoutersPerDomain: {} };
  const feeMgr = provider.createFeeArtifactManager(spec.chainMetadata, ctx);
  if (!feeMgr) {
    logger.warn(
      { chainName: spec.origin },
      'Sealevel fee artifact manager unavailable — skipping warp fee for this route',
    );
    return undefined;
  }
  try {
    const artifact = await feeMgr.readFee(feeProgram, ctx);
    return { feeAccountPda, config: artifact.config };
  } catch (err) {
    logger.warn(
      { chainName: spec.origin, feeProgram, err },
      'Failed to read SVM fee artifact — skipping warp fee for this route',
    );
    return undefined;
  }
}

async function tryReadSvmIgp(
  provider: ReturnType<typeof getProtocolProvider>,
  spec: SvmRouteSpec,
  hookProgramId: string,
  logger: Logger,
): Promise<SvmRouteState['igp'] | undefined> {
  const hookMgr = provider.createHookArtifactManager(spec.chainMetadata);
  try {
    const artifact = await hookMgr.readHook(hookProgramId);
    if (!isSealevelDeployedIgpHook(artifact.deployed)) {
      logger.debug(
        { chainName: spec.origin, hookProgramId },
        'SVM hook is not an IGP — skipping IGP quoter for this route',
      );
      return undefined;
    }
    const signers = artifact.deployed.feeConfig?.signers ?? [];
    return { igpAccountPda: artifact.deployed.igpPda, signers };
  } catch (err) {
    logger.warn(
      { chainName: spec.origin, hookProgramId, err },
      'Failed to read SVM IGP artifact — skipping IGP quoter for this route',
    );
    return undefined;
  }
}

// ============ fee-tree walking (artifact API) ============

interface ResolvedSvmWarpQuote {
  quoteSigners: string[];
  /**
   * Encoder input for `encodeSvmFeeQuoteContext`. `targetRouter` is set iff
   * the leaf came from a `CrossCollateralRouting` parent — the runtime
   * discriminator between the 44B Leaf/Routing context and the 76B
   * Cross-Collateral context.
   */
  contextInput: SvmFeeQuoteContextInput;
}

/**
 * Walks the artifact-API fee tree (`FeeArtifactConfig`) for the destination
 * domain. The artifact form caps tree depth at 2 — `routes` children are
 * `FeeStrategy` leaves (no nested `RoutingFee` allowed) — so the walk is a
 * single branch + lookup, no recursion.
 *
 * `feeAccountPda` is the same address at every level (SVM stores the whole
 * tree in one account), so it's threaded through for error-message clarity
 * rather than tracked per node.
 *
 * Only `quoteSigners` and the CC-vs-non-CC discriminator are read off the
 * leaf — the strategy params signed on the wire come from
 * `PLACEHOLDER_WARP_FEE_PARAMS`, not the on-chain values, mirroring EVM.
 */
function resolveSvmWarpQuote(
  config: FeeArtifactConfig,
  destinationDomain: number,
  recipient: Uint8Array,
  targetRouter: Uint8Array,
  feeAccountPda: string,
): ResolvedSvmWarpQuote {
  const { leaf, isCrossCollateral } = pickLeaf(
    config,
    destinationDomain,
    targetRouter,
    feeAccountPda,
  );

  if (leaf.type !== FeeType.offchainQuotedLinear) {
    throw new NoQuoteAvailableError(
      NoQuoteAvailableReason.NotUpgraded,
      `Fee leaf on ${feeAccountPda} is ${leaf.type}, not OffchainQuotedLinearFee`,
    );
  }

  return {
    quoteSigners: leaf.quoteSigners,
    contextInput: {
      destinationDomain,
      recipient,
      amount: WILDCARD_AMOUNT,
      targetRouter: isCrossCollateral ? targetRouter : undefined,
    },
  };
}

type FeeLeafLike = FeeArtifactConfig | FeeStrategy;

function pickLeaf(
  config: FeeArtifactConfig,
  destinationDomain: number,
  targetRouter: Uint8Array,
  feeAccountPda: string,
): { leaf: FeeLeafLike; isCrossCollateral: boolean } {
  switch (config.type) {
    case FeeType.linear:
    case FeeType.regressive:
    case FeeType.progressive:
    case FeeType.offchainQuotedLinear:
      // Top-level leaf — return as-is. Extra BaseFeeConfig fields don't hurt
      // since the consumer only reads `type`, `params`, `quoteSigners`.
      return { leaf: config, isCrossCollateral: false };
    case FeeType.routing: {
      const child = config.routes[destinationDomain];
      if (!child) {
        throw new NoQuoteAvailableError(
          NoQuoteAvailableReason.NotConfigured,
          `No fee route on ${feeAccountPda} for destination domain ${destinationDomain}`,
        );
      }
      return { leaf: child, isCrossCollateral: false };
    }
    case FeeType.crossCollateralRouting: {
      const destRoutes = config.routes[destinationDomain];
      if (!destRoutes) {
        throw new NoQuoteAvailableError(
          NoQuoteAvailableReason.NotConfigured,
          `No CC fee route on ${feeAccountPda} for destination domain ${destinationDomain}`,
        );
      }
      const targetRouterKey: Hex = bytesToHex(targetRouter);
      const child =
        destRoutes[targetRouterKey] ?? destRoutes[DEFAULT_ROUTER_KEY];
      if (!child) {
        throw new NoQuoteAvailableError(
          NoQuoteAvailableReason.NotConfigured,
          `No CC fee route on ${feeAccountPda} for ${destinationDomain}/${targetRouterKey} (no default fallback)`,
        );
      }
      return { leaf: child, isCrossCollateral: true };
    }
    default: {
      const _exhaustive: never = config;
      throw new Error(
        `Unhandled FeeArtifactConfig type: ${String(_exhaustive)}`,
      );
    }
  }
}

// ============ binding → bigint timestamps ============

function resolveTimestamps(binding: QuoteBinding): {
  issuedAt: bigint;
  expiry: bigint;
} {
  const now = BigInt(Math.floor(Date.now() / 1000));
  // Transient: issuedAt = expiry = now + buffer. The buffer absorbs
  // block-time skew when the tx lands. Standing: issuedAt = now, expiry =
  // now + ttlSeconds.
  if (binding.kind === QuoteMode.TRANSIENT) {
    const ts = now + BigInt(binding.transientBuffer);
    return { issuedAt: ts, expiry: ts };
  }
  return { issuedAt: now, expiry: now + BigInt(binding.ttlSeconds) };
}

// ============ SealevelQuoteV2Entry shaping ============

function shapeEntry(args: {
  quoter: string;
  domainId: number;
  issuedAt: number;
  expiry: number;
  signed: SvmSignedQuote;
}): SealevelQuoteV2Entry {
  return {
    protocol: ProtocolType.Sealevel,
    quoter: args.quoter,
    issuedAt: args.issuedAt,
    expiry: args.expiry,
    details: {
      domainId: args.domainId,
      signedQuote: {
        context: bytesToHex(args.signed.context),
        data: bytesToHex(args.signed.data),
        issuedAt: bytesToHex(args.signed.issuedAt),
        expiry: bytesToHex(args.signed.expiry),
        clientSalt: bytesToHex(args.signed.clientSalt),
        signature: bytesToHex(args.signed.signature),
      },
    },
  };
}
