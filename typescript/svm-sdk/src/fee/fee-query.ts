import type { Address } from '@solana/kit';

import { FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import { isNullish } from '@hyperlane-xyz/utils';

import {
  decodeFeeAccount,
  decodeCrossCollateralRoute,
  decodeRouteDomain,
  type CrossCollateralRouteData,
  type FeeAccountData,
  type DecodedFeeData,
  type RouteDomainData,
} from '../accounts/fee.js';
import {
  deriveCrossCollateralRoutePda,
  deriveFeeAccountPda,
  deriveRouteDomainPda,
} from '../pda.js';
import { fetchAccountDataRaw } from '../rpc.js';
import type { SvmRpc } from '../types.js';
import { FeeDataKind, FeeStrategyKind } from './types.js';

export async function fetchFeeAccount(
  rpc: SvmRpc,
  programId: Address,
  salt: Uint8Array,
): Promise<FeeAccountData | null> {
  const { address: feeAccountPda } = await deriveFeeAccountPda(programId, salt);
  const raw = await fetchAccountDataRaw(rpc, feeAccountPda);
  if (!raw || raw.length === 0) return null;
  return decodeFeeAccount(raw);
}

/**
 * Maps an on-chain FeeData variant to the provider-sdk FeeType.
 * For Leaf variants, checks whether signers is Some (not None) to distinguish
 * offchain-quoted from pure on-chain strategies. An empty Some([]) still means
 * offchain quoting is enabled — it's distinct from None (no quoting at all).
 *
 * Note: provider-sdk only models offchainQuotedLinear; on-chain signers are
 * orthogonal to strategy kind, so any strategy with signers maps here.
 */
export function detectSvmFeeType(feeData: DecodedFeeData): FeeType {
  switch (feeData.kind) {
    case FeeDataKind.Leaf: {
      if (!isNullish(feeData.signers)) return FeeType.offchainQuotedLinear;
      return strategyKindToFeeType(feeData.strategy.kind);
    }
    case FeeDataKind.Routing:
      return FeeType.routing;
    case FeeDataKind.CrossCollateralRouting:
      return FeeType.crossCollateralRouting;
  }
}

export async function fetchRouteDomain(
  rpc: SvmRpc,
  programId: Address,
  feeAccount: Address,
  domain: number,
): Promise<RouteDomainData | null> {
  const { address: routePda } = await deriveRouteDomainPda(
    programId,
    feeAccount,
    domain,
  );
  const raw = await fetchAccountDataRaw(rpc, routePda);
  if (!raw || raw.length === 0) return null;
  return decodeRouteDomain(raw);
}

export async function fetchCrossCollateralRoute(
  rpc: SvmRpc,
  programId: Address,
  feeAccount: Address,
  destination: number,
  targetRouter: Uint8Array,
): Promise<CrossCollateralRouteData | null> {
  const { address: ccRoutePda } = await deriveCrossCollateralRoutePda(
    programId,
    feeAccount,
    destination,
    targetRouter,
  );
  const raw = await fetchAccountDataRaw(rpc, ccRoutePda);
  if (!raw || raw.length === 0) return null;
  return decodeCrossCollateralRoute(raw);
}

function strategyKindToFeeType(kind: number): FeeType {
  switch (kind) {
    case FeeStrategyKind.Linear:
      return FeeType.linear;
    case FeeStrategyKind.Regressive:
      return FeeType.regressive;
    case FeeStrategyKind.Progressive:
      return FeeType.progressive;
    default:
      throw new Error(`Unknown FeeDataStrategy kind: ${kind}`);
  }
}
