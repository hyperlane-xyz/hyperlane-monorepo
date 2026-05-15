import { type Address, address as parseAddress } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  isArtifactDeployed,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type FeeArtifactConfig,
  type FeeReadContext,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import type {
  DeployedWarpAddress,
  WarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish, strip0x, toHexString } from '@hyperlane-xyz/utils';

import { DEFAULT_ROUTER } from '../codecs/fee.js';
import { WILDCARD_DOMAIN, WILDCARD_SENDER } from '../codecs/igp.js';
import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import { H256_ZERO } from '../instructions/fee.js';
import {
  deriveCrossCollateralRoutePda,
  deriveFeeAccountPda,
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveIgpStandingQuotePda,
  deriveMailboxOutboxPda,
  deriveOverheadIgpAccountPda,
  deriveRouteDomainPda,
  deriveStandingQuotePda,
} from '../pda.js';
import type { SvmReceipt } from '../types.js';

import {
  type SvmAddressLookupTableReader,
  type SvmAddressLookupTableWriter,
  type SvmAltConfig,
  type SvmDeployedAlt,
  nonEmptyArray,
} from './address-lookup-table.js';

export interface SvmCoreDeploymentAltIgpContext {
  programId: Address;
  igpSalt: Uint8Array;
  includeOverheadIgp?: boolean;
}

/**
 * A single ALT entry with a human-readable label describing what role
 * the address plays in the warp / fee / IGP cascade. The label is SDK-
 * derived (we know what we put in the ALT) so it surfaces in `warp
 * alt check` diffs as "missing: fee.standing_quote(domain=10)" instead
 * of a bare base58 string, letting operators diagnose drift without
 * cross-referencing PDA derivations.
 *
 * The on-chain ALT only stores raw pubkeys — descriptions are
 * stripped just before persistence via `createWarpAltsImpl`.
 */
export interface AnnotatedAltAddress {
  address: Address;
  description: string;
}

function annotate(address: Address, description: string): AnnotatedAltAddress {
  return { address, description };
}

function routerLabel(router: Uint8Array): string {
  return toHexString(Buffer.from(router));
}

/**
 * Derives the chain-level address set every SVM warp route on a given
 * chain wants in its ALTs: SDK constants, mailbox/outbox, and the
 * optional IGP quad. Output is set-deduped and base58-sorted so the
 * caller gets a canonical, diff-stable list. ALT-tx semantics are
 * order-agnostic — `compressTransactionMessageUsingAddressLookupTables`
 * is a pure set-membership index substitution — so any caller-chosen
 * ordering is safe on-chain; sorting is purely for predictable diffs.
 */
export async function deriveCoreDeploymentAltAddresses(
  mailbox: Address,
  igp?: SvmCoreDeploymentAltIgpContext,
): Promise<AnnotatedAltAddress[]> {
  const outbox = (await deriveMailboxOutboxPda(mailbox)).address;
  const out: AnnotatedAltAddress[] = [
    annotate(SYSTEM_PROGRAM_ADDRESS, 'system_program'),
    annotate(SPL_NOOP_PROGRAM_ADDRESS, 'spl_noop'),
    annotate(SPL_TOKEN_PROGRAM_ADDRESS, 'spl_token_program'),
    annotate(mailbox, 'mailbox'),
    annotate(outbox, 'mailbox.outbox'),
  ];

  if (igp) {
    const { programId, igpSalt, includeOverheadIgp } = igp;

    const programData = await deriveIgpProgramDataPda(programId);
    const igpAccount = await deriveIgpAccountPda(programId, igpSalt);
    out.push(
      annotate(programId, 'igp.program'),
      annotate(programData.address, 'igp.program_data'),
      annotate(igpAccount.address, 'igp.account'),
    );

    if (includeOverheadIgp) {
      const overhead = await deriveOverheadIgpAccountPda(programId, igpSalt);
      out.push(annotate(overhead.address, 'igp.overhead_account'));
    }
  }
  return canonicalize(out);
}

/**
 * Derives every fee-program-related address an SVM warp route may
 * touch via the on-chain `QuoteFee` handler: the fee program itself,
 * the fee account PDA derived from `(feeProgram, feeSalt)`, and the
 * per-destination cascade PDAs the handler reads through. Dispatches
 * on `feeConfig.type` to the right variant cascade — `Leaf`,
 * `Routing`, or `CrossCollateralRouting` — mirroring
 * `processor/quote.rs::process_quote_fee` in the fee program.
 *
 * Enrolled destinations / target routers come from the caller's
 * `FeeReadContext`, which is the same shape the fee
 * reader/writer already consume (built via
 * `buildFeeReadContextFromWarpArtifactConfig`).
 *
 * Output is base58-sorted and set-deduped so `warp alt check` diffs
 * are stable. Tx semantics are order-agnostic on chain.
 */
export async function deriveFeeQuoteCascadeAltAddresses(args: {
  feeProgram: Address;
  feeSalt: Uint8Array;
  feeConfig: FeeArtifactConfig;
  feeReadContext: FeeReadContext;
}): Promise<AnnotatedAltAddress[]> {
  const { feeProgram, feeSalt, feeConfig, feeReadContext } = args;
  const feeAccount = await deriveFeeAccountPda(feeProgram, feeSalt);
  const cascadeArgs = {
    feeProgram,
    feeAccount: feeAccount.address,
    feeReadContext,
  };

  let cascade: AnnotatedAltAddress[];
  switch (feeConfig.type) {
    case FeeType.linear:
    case FeeType.regressive:
    case FeeType.progressive:
    case FeeType.offchainQuotedLinear:
      cascade = await deriveLeafFeeCascade(cascadeArgs);
      break;
    case FeeType.routing:
      cascade = await deriveRoutingFeeCascade(cascadeArgs);
      break;
    case FeeType.crossCollateralRouting:
      cascade = await deriveCrossCollateralFeeCascade(cascadeArgs);
      break;
    default: {
      const _exhaustive: never = feeConfig;
      throw new Error(
        `Unhandled fee config type: ${String((_exhaustive as { type?: unknown }).type)}`,
      );
    }
  }

  return canonicalize([
    annotate(feeProgram, 'fee.program'),
    annotate(feeAccount.address, 'fee.account'),
    ...cascade,
  ]);
}

async function deriveLeafFeeCascade(args: {
  feeProgram: Address;
  feeAccount: Address;
  feeReadContext: FeeReadContext;
}): Promise<AnnotatedAltAddress[]> {
  const { feeProgram, feeAccount, feeReadContext } = args;
  const out: AnnotatedAltAddress[] = [];

  for (const domainStr of Object.keys(feeReadContext.knownRoutersPerDomain)) {
    const domain = Number(domainStr);
    const standing = await deriveStandingQuotePda(
      feeProgram,
      feeAccount,
      domain,
      H256_ZERO,
    );
    out.push(
      annotate(standing.address, `fee.standing_quote(domain=${domain})`),
    );
  }

  const wildcardStanding = await deriveStandingQuotePda(
    feeProgram,
    feeAccount,
    WILDCARD_DOMAIN,
    H256_ZERO,
  );
  out.push(
    annotate(wildcardStanding.address, 'fee.standing_quote(domain=wildcard)'),
  );

  return out;
}

async function deriveRoutingFeeCascade(args: {
  feeProgram: Address;
  feeAccount: Address;
  feeReadContext: FeeReadContext;
}): Promise<AnnotatedAltAddress[]> {
  const { feeProgram, feeAccount, feeReadContext } = args;
  const out = await deriveLeafFeeCascade(args);

  for (const domainStr of Object.keys(feeReadContext.knownRoutersPerDomain)) {
    const domain = Number(domainStr);
    const route = await deriveRouteDomainPda(feeProgram, feeAccount, domain);
    out.push(annotate(route.address, `fee.route(domain=${domain})`));
  }

  return out;
}

async function deriveCrossCollateralFeeCascade(args: {
  feeProgram: Address;
  feeAccount: Address;
  feeReadContext: FeeReadContext;
}): Promise<AnnotatedAltAddress[]> {
  const { feeProgram, feeAccount, feeReadContext } = args;
  const out: AnnotatedAltAddress[] = [];

  for (const [domainStr, routers] of Object.entries(
    feeReadContext.knownRoutersPerDomain,
  )) {
    const domain = Number(domainStr);

    const defaultRoute = await deriveCrossCollateralRoutePda(
      feeProgram,
      feeAccount,
      domain,
      DEFAULT_ROUTER,
    );
    out.push(
      annotate(
        defaultRoute.address,
        `fee.cc_route(domain=${domain}, target_router=DEFAULT)`,
      ),
    );

    const defaultStanding = await deriveStandingQuotePda(
      feeProgram,
      feeAccount,
      domain,
      DEFAULT_ROUTER,
    );
    out.push(
      annotate(
        defaultStanding.address,
        `fee.cc_standing_quote(domain=${domain}, target_router=DEFAULT)`,
      ),
    );

    for (const routerHex of routers) {
      const router = Uint8Array.from(Buffer.from(strip0x(routerHex), 'hex'));
      const routerHexLabel = routerLabel(router);

      const ccRoute = await deriveCrossCollateralRoutePda(
        feeProgram,
        feeAccount,
        domain,
        router,
      );
      out.push(
        annotate(
          ccRoute.address,
          `fee.cc_route(domain=${domain}, target_router=${routerHexLabel})`,
        ),
      );

      const standing = await deriveStandingQuotePda(
        feeProgram,
        feeAccount,
        domain,
        router,
      );
      out.push(
        annotate(
          standing.address,
          `fee.cc_standing_quote(domain=${domain}, target_router=${routerHexLabel})`,
        ),
      );

      const wildcardStanding = await deriveStandingQuotePda(
        feeProgram,
        feeAccount,
        WILDCARD_DOMAIN,
        router,
      );
      out.push(
        annotate(
          wildcardStanding.address,
          `fee.cc_standing_quote(domain=wildcard, target_router=${routerHexLabel})`,
        ),
      );
    }
  }

  return out;
}

/**
 * Derives the per-destination IGP-quote cascade PDAs the on-chain
 * IGP `QuoteGasPayment` handler reads through. Mirrors the on-chain
 * standing-quote lookup: per-destination + per-sender, plus the
 * domain-wildcard PDA for the same sender, plus the fully-wildcard PDA
 * (domain + sender both wildcards) that any sender falls back to.
 *
 * `feeTokenMint` is the IGP fee-token mint configured on chain.
 * Picked by the caller per warp type:
 *   - native            → SYSTEM_PROGRAM_ADDRESS (Pubkey::default())
 *   - synthetic         → derived synthetic mint PDA
 *   - collateral / CC   → the collateralized token mint
 *
 * SPL-token IGP payment isn't wired up yet — every IGP cascade today
 * resolves against the native-token sentinel (`Pubkey::default()` ==
 * `SYSTEM_PROGRAM_ADDRESS`). The helper emits PDAs for both the
 * caller-provided `feeTokenMint` AND the native sentinel so the ALT
 * stays valid both now (native-only) and once SPL IGP payment lands.
 * When the caller's mint already is the native sentinel, the two
 * cascades collapse via dedup.
 *
 * Output is base58-sorted and set-deduped.
 */
export async function deriveIgpQuoteCascadeAltAddresses(args: {
  igpProgram: Address;
  igpAccount: Address;
  feeTokenMint: Address;
  sender: Address;
  enrolledDomains: number[];
}): Promise<AnnotatedAltAddress[]> {
  const { igpProgram, igpAccount, feeTokenMint, sender, enrolledDomains } =
    args;
  const out: AnnotatedAltAddress[] = [];

  for (const mint of [feeTokenMint, SYSTEM_PROGRAM_ADDRESS]) {
    const mintLabel = mint === SYSTEM_PROGRAM_ADDRESS ? 'native' : mint;
    for (const domain of enrolledDomains) {
      const perDest = await deriveIgpStandingQuotePda(
        igpProgram,
        igpAccount,
        mint,
        domain,
        sender,
      );
      out.push(
        annotate(
          perDest.address,
          `igp.standing_quote(mint=${mintLabel}, domain=${domain}, sender=self)`,
        ),
      );
    }

    const perSenderWildcard = await deriveIgpStandingQuotePda(
      igpProgram,
      igpAccount,
      mint,
      WILDCARD_DOMAIN,
      sender,
    );
    out.push(
      annotate(
        perSenderWildcard.address,
        `igp.standing_quote(mint=${mintLabel}, domain=wildcard, sender=self)`,
      ),
    );

    const fullyWildcard = await deriveIgpStandingQuotePda(
      igpProgram,
      igpAccount,
      mint,
      WILDCARD_DOMAIN,
      WILDCARD_SENDER,
    );
    out.push(
      annotate(
        fullyWildcard.address,
        `igp.standing_quote(mint=${mintLabel}, domain=wildcard, sender=wildcard)`,
      ),
    );
  }

  return canonicalize(out);
}

export function canonicalize(
  entries: readonly AnnotatedAltAddress[],
): AnnotatedAltAddress[] {
  const seen = new Map<Address, AnnotatedAltAddress>();
  for (const entry of entries) {
    const addr = parseAddress(entry.address);
    if (!seen.has(addr)) {
      seen.set(addr, { address: addr, description: entry.description });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
}

/**
 * Set-level diff between an on-chain ALT's contents and the expected
 * address list a per-token-type alt writer would regenerate. `unfrozen`
 * reflects the on-chain ALT's freeze status — since alt writers always
 * emit frozen tables, an unfrozen actual is treated as a divergence.
 *
 * Shared across token-type alt writers — each writer reuses this for
 * its `check` method's bucket diffs.
 */
export interface BucketDiff {
  missingFromAlt: AnnotatedAltAddress[];
  extraInAlt: Address[];
  unfrozen: boolean;
}

export function diffBucket(
  actual: readonly Address[],
  expected: readonly AnnotatedAltAddress[],
  frozen: boolean,
): BucketDiff {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected.map((e) => e.address));
  return {
    missingFromAlt: expected.filter((e) => !actualSet.has(e.address)),
    extraInAlt: actual.filter((a) => !expectedSet.has(a)),
    unfrozen: !frozen,
  };
}

/**
 * Read-only surface every per-token-type ALT reader satisfies. Each
 * concrete reader specializes `C` to its `WarpArtifactConfig` variant.
 * The `SvmWarpAltReader` dispatcher uses this as the return type of
 * `createReader(type)`.
 */
export interface SvmTokenAltReader<C> {
  deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<C, DeployedWarpAddress>,
  ): Promise<AnnotatedAltAddress[]>;

  read(addresses: { core: string; warpSpecific: string[] }): Promise<{
    core: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>;
    warpSpecific: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>[];
  }>;

  check(
    addresses: { core: string; warpSpecific: string[] },
    deployed: ArtifactDeployed<C, DeployedWarpAddress>,
  ): Promise<{ core: BucketDiff; warpSpecific: BucketDiff }>;
}

/**
 * Adds the signer-requiring `create` path on top of the read surface.
 * `SvmWarpAltManager.createWriter(type)` returns this variant.
 */
export interface SvmTokenAltWriter<C> extends SvmTokenAltReader<C> {
  create(deployed: ArtifactDeployed<C, DeployedWarpAddress>): Promise<{
    core: Address;
    warpSpecific: Address[];
    receipts: SvmReceipt[];
  }>;
}

/**
 * Shared base for per-token-type SVM warp ALT readers. Owns the
 * `read` pass-through, the `check` set-diff against expected addresses,
 * and the `computeExpectedAltAddresses` glue (mailbox + IGP cascade
 * + per-token warp-specific bucket). Concrete subclasses implement
 * only `deriveWarpRouteAddresses` — the warp-specific address set
 * each token type contributes to the ALT.
 */
export abstract class SvmTokenAltReaderBase<
  C extends WarpArtifactConfig,
> implements SvmTokenAltReader<C> {
  constructor(
    protected readonly chainName: string,
    protected readonly altReader: SvmAddressLookupTableReader,
  ) {}

  abstract deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<C, DeployedWarpAddress>,
  ): Promise<AnnotatedAltAddress[]>;

  async read(addresses: { core: string; warpSpecific: string[] }): Promise<{
    core: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>;
    warpSpecific: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>[];
  }> {
    const core = await this.altReader.read(addresses.core);
    const warpSpecific = await Promise.all(
      addresses.warpSpecific.map((addr) => this.altReader.read(addr)),
    );
    return { core, warpSpecific };
  }

  async check(
    addresses: { core: string; warpSpecific: string[] },
    deployed: ArtifactDeployed<C, DeployedWarpAddress>,
  ): Promise<{ core: BucketDiff; warpSpecific: BucketDiff }> {
    const actual = await this.read(addresses);
    const expected = await this.computeExpectedAltAddresses(deployed);

    return {
      core: diffBucket(
        actual.core.config.addresses,
        expected.core,
        actual.core.config.frozen,
      ),
      warpSpecific: diffBucket(
        actual.warpSpecific.flatMap((a) => a.config.addresses),
        expected.warpSpecific,
        actual.warpSpecific.every((a) => a.config.frozen),
      ),
    };
  }

  protected async computeExpectedAltAddresses(
    deployed: ArtifactDeployed<C, DeployedWarpAddress>,
  ): Promise<{
    core: AnnotatedAltAddress[];
    warpSpecific: AnnotatedAltAddress[];
  }> {
    const mailbox = parseAddress(deployed.config.mailbox);
    const hook = deployed.config.hook;
    assert(
      isNullish(hook) || isArtifactDeployed(hook),
      'Expected hook artifact to be expanded (DEPLOYED) or not set',
    );
    const igpContext =
      hook?.config.type === HookType.INTERCHAIN_GAS_PAYMASTER
        ? {
            programId: parseAddress(hook.deployed.address),
            igpSalt: DEFAULT_IGP_SALT,
            includeOverheadIgp: Object.keys(hook.config.overhead).length > 0,
          }
        : undefined;

    return {
      core: await deriveCoreDeploymentAltAddresses(mailbox, igpContext),
      warpSpecific: await this.deriveWarpRouteAddresses(deployed),
    };
  }
}

/**
 * Shared `create` body for per-token-type writers — emits the two
 * frozen ALTs (core + warp-specific) and returns the typed bundle.
 * Each writer's `create` reduces to: compute expected addresses, then
 * delegate here.
 */
export async function createWarpAltsImpl(
  altWriter: SvmAddressLookupTableWriter,
  {
    core,
    warpSpecific,
  }: { core: AnnotatedAltAddress[]; warpSpecific: AnnotatedAltAddress[] },
): Promise<{
  core: Address;
  warpSpecific: Address[];
  receipts: SvmReceipt[];
}> {
  const [coreAlt, coreReceipts] = await altWriter.create({
    config: {
      frozen: true,
      addresses: nonEmptyArray(core.map((e) => e.address)),
    },
  });
  const [warpAlt, warpReceipts] = await altWriter.create({
    config: {
      frozen: true,
      addresses: nonEmptyArray(warpSpecific.map((e) => e.address)),
    },
  });

  return {
    core: coreAlt.deployed.address,
    warpSpecific: [warpAlt.deployed.address],
    receipts: [...coreReceipts, ...warpReceipts],
  };
}
