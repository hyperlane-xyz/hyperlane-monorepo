import type { Address } from '@solana/kit';

import { FeeType } from '@hyperlane-xyz/provider-sdk/fee';

import {
  decodeFeeAccount,
  type FeeAccountData,
  type DecodedFeeData,
} from '../accounts/fee.js';
import { deriveFeeAccountPda } from '../pda.js';
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
 * For Leaf variants, also considers whether signers are present
 * to distinguish offchainQuotedLinear from the pure strategy types.
 */
export function detectSvmFeeType(feeData: DecodedFeeData): FeeType {
  switch (feeData.kind) {
    case FeeDataKind.Leaf: {
      const hasSigners = feeData.signers !== null && feeData.signers.length > 0;
      if (hasSigners) return FeeType.offchainQuotedLinear;
      return strategyKindToFeeType(feeData.strategy.kind);
    }
    case FeeDataKind.Routing:
      return FeeType.routing;
    case FeeDataKind.CrossCollateralRouting:
      return FeeType.crossCollateralRouting;
  }
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
