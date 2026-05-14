import { type Address, address as parseAddress } from '@solana/kit';

import { type ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type FeeArtifactConfig,
  type FeeReadContext,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import type { DeployedWarpAddress } from '@hyperlane-xyz/provider-sdk/warp';
import { strip0x } from '@hyperlane-xyz/utils';

import { DEFAULT_ROUTER } from '../codecs/fee.js';
import { WILDCARD_DOMAIN, WILDCARD_SENDER } from '../codecs/igp.js';
import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
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

import type { SvmAltConfig, SvmDeployedAlt } from './address-lookup-table.js';

export interface SvmCoreDeploymentAltIgpContext {
  programId: Address;
  igpSalt: Uint8Array;
  includeOverheadIgp?: boolean;
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
): Promise<Address[]> {
  const outbox = (await deriveMailboxOutboxPda(mailbox)).address;
  const out: Address[] = [
    SYSTEM_PROGRAM_ADDRESS,
    SPL_NOOP_PROGRAM_ADDRESS,
    SPL_TOKEN_PROGRAM_ADDRESS,
    mailbox,
    outbox,
  ];

  if (igp) {
    const { programId, igpSalt, includeOverheadIgp } = igp;

    const programData = await deriveIgpProgramDataPda(programId);
    const igpAccount = await deriveIgpAccountPda(programId, igpSalt);
    out.push(programId, programData.address, igpAccount.address);

    if (includeOverheadIgp) {
      const overhead = await deriveOverheadIgpAccountPda(programId, igpSalt);
      out.push(overhead.address);
    }
  }
  return [...new Set(out.map(parseAddress))].sort();
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
}): Promise<Address[]> {
  const { feeProgram, feeSalt, feeConfig, feeReadContext } = args;
  const feeAccount = await deriveFeeAccountPda(feeProgram, feeSalt);
  const cascadeArgs = {
    feeProgram,
    feeAccount: feeAccount.address,
    feeReadContext,
  };

  let cascade: Address[];
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

  return canonicalize([feeProgram, feeAccount.address, ...cascade]);
}

async function deriveLeafFeeCascade(args: {
  feeProgram: Address;
  feeAccount: Address;
  feeReadContext: FeeReadContext;
}): Promise<Address[]> {
  const { feeProgram, feeAccount, feeReadContext } = args;
  const out: Address[] = [];

  for (const domainStr of Object.keys(feeReadContext.knownRoutersPerDomain)) {
    const domain = Number(domainStr);
    const standing = await deriveStandingQuotePda(
      feeProgram,
      feeAccount,
      domain,
      H256_ZERO,
    );
    out.push(standing.address);
  }

  const wildcardStanding = await deriveStandingQuotePda(
    feeProgram,
    feeAccount,
    WILDCARD_DOMAIN,
    H256_ZERO,
  );
  out.push(wildcardStanding.address);

  return out;
}

async function deriveRoutingFeeCascade(args: {
  feeProgram: Address;
  feeAccount: Address;
  feeReadContext: FeeReadContext;
}): Promise<Address[]> {
  const { feeProgram, feeAccount, feeReadContext } = args;
  const out = await deriveLeafFeeCascade(args);

  for (const domainStr of Object.keys(feeReadContext.knownRoutersPerDomain)) {
    const domain = Number(domainStr);
    const route = await deriveRouteDomainPda(feeProgram, feeAccount, domain);
    out.push(route.address);
  }

  return out;
}

async function deriveCrossCollateralFeeCascade(args: {
  feeProgram: Address;
  feeAccount: Address;
  feeReadContext: FeeReadContext;
}): Promise<Address[]> {
  const { feeProgram, feeAccount, feeReadContext } = args;
  const out: Address[] = [];

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
    out.push(defaultRoute.address);

    const defaultStanding = await deriveStandingQuotePda(
      feeProgram,
      feeAccount,
      domain,
      DEFAULT_ROUTER,
    );
    out.push(defaultStanding.address);

    for (const routerHex of routers) {
      const router = Uint8Array.from(Buffer.from(strip0x(routerHex), 'hex'));

      const ccRoute = await deriveCrossCollateralRoutePda(
        feeProgram,
        feeAccount,
        domain,
        router,
      );
      out.push(ccRoute.address);

      const standing = await deriveStandingQuotePda(
        feeProgram,
        feeAccount,
        domain,
        router,
      );
      out.push(standing.address);

      const wildcardStanding = await deriveStandingQuotePda(
        feeProgram,
        feeAccount,
        WILDCARD_DOMAIN,
        router,
      );
      out.push(wildcardStanding.address);
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
}): Promise<Address[]> {
  const { igpProgram, igpAccount, feeTokenMint, sender, enrolledDomains } =
    args;
  const out: Address[] = [];

  for (const mint of [feeTokenMint, SYSTEM_PROGRAM_ADDRESS]) {
    for (const domain of enrolledDomains) {
      const perDest = await deriveIgpStandingQuotePda(
        igpProgram,
        igpAccount,
        mint,
        domain,
        sender,
      );
      out.push(perDest.address);
    }

    const perSenderWildcard = await deriveIgpStandingQuotePda(
      igpProgram,
      igpAccount,
      mint,
      WILDCARD_DOMAIN,
      sender,
    );
    out.push(perSenderWildcard.address);

    const fullyWildcard = await deriveIgpStandingQuotePda(
      igpProgram,
      igpAccount,
      mint,
      WILDCARD_DOMAIN,
      WILDCARD_SENDER,
    );
    out.push(fullyWildcard.address);
  }

  return canonicalize(out);
}

function canonicalize(addresses: readonly Address[]): Address[] {
  return [...new Set(addresses.map(parseAddress))].sort();
}

/**
 * Set-level diff between an on-chain ALT's contents and the expected
 * address list a per-token-type alt writer would regenerate. `frozen`
 * is the on-chain ALT's freeze status; since alt writers always emit
 * frozen tables, an unfrozen actual is treated as a divergence.
 *
 * Shared across token-type alt writers — each writer reuses this for
 * its `check` method's bucket diffs.
 */
export interface BucketDiff {
  missingFromAlt: Address[];
  extraInAlt: Address[];
  frozenMismatch: boolean;
}

export function diffBucket(
  actual: readonly Address[],
  expected: readonly Address[],
  frozen: boolean,
): BucketDiff {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missingFromAlt: expected.filter((a) => !actualSet.has(a)),
    extraInAlt: actual.filter((a) => !expectedSet.has(a)),
    frozenMismatch: !frozen,
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
  ): Promise<Address[]>;

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
