import { type Address, address as parseAddress } from '@solana/kit';

import {
  type FeeArtifactConfig,
  type FeeReadContext,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import { strip0x } from '@hyperlane-xyz/utils';

import { DEFAULT_ROUTER } from '../codecs/fee.js';
import { WILDCARD_DOMAIN } from '../codecs/igp.js';
import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { H256_ZERO } from '../instructions/fee.js';
import {
  deriveCrossCollateralRoutePda,
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveMailboxOutboxPda,
  deriveOverheadIgpAccountPda,
  deriveRouteDomainPda,
  deriveStandingQuotePda,
} from '../pda.js';

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
 * Derives the per-destination fee-quote cascade PDAs the on-chain
 * `QuoteFee` handler reads through, excluding the fee account itself
 * (that one lives in the per-token warp-specific bucket). Dispatches
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
  feeAccount: Address;
  feeConfig: FeeArtifactConfig;
  feeReadContext: FeeReadContext;
}): Promise<Address[]> {
  let out: Address[];
  switch (args.feeConfig.type) {
    case FeeType.linear:
    case FeeType.regressive:
    case FeeType.progressive:
    case FeeType.offchainQuotedLinear:
      out = await deriveLeafFeeCascade(args);
      break;
    case FeeType.routing:
      out = await deriveRoutingFeeCascade(args);
      break;
    case FeeType.crossCollateralRouting:
      out = await deriveCrossCollateralFeeCascade(args);
      break;
    default: {
      const _exhaustive: never = args.feeConfig;
      throw new Error(
        `Unhandled fee config type: ${String((_exhaustive as { type?: unknown }).type)}`,
      );
    }
  }

  return canonicalize(out);
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

function canonicalize(addresses: readonly Address[]): Address[] {
  return [...new Set(addresses.map(parseAddress))].sort();
}
