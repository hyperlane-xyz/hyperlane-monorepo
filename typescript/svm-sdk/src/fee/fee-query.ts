import type { Address } from '@solana/kit';

import { FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import { assert } from '@hyperlane-xyz/utils';

import {
  type CrossCollateralRouteData,
  decodeCrossCollateralRoute,
  decodeFeeAccount,
  type DecodedFeeData,
  decodeRouteDomain,
  type FeeAccountData,
  type RouteDomainData,
} from '../accounts/fee.js';
import { FeeDataKind, FeeStrategyKind } from '../fee/types.js';
import {
  deriveCrossCollateralRoutePda,
  deriveFeeAccountPda,
  deriveRouteDomainPda,
} from '../pda.js';
import { fetchAccountDataRaw } from '../rpc.js';
import type { SvmRpc } from '../types.js';

/**
 * Fetches and decodes the FeeAccount PDA for a given fee program and salt.
 * Returns null if the account does not exist or is not initialized.
 */
export async function fetchFeeAccount(
  rpc: SvmRpc,
  programId: Address,
  salt: Uint8Array,
): Promise<FeeAccountData | null> {
  const { address: feeAccountPda } = await deriveFeeAccountPda(programId, salt);
  const data = await fetchAccountDataRaw(rpc, feeAccountPda);
  if (!data) return null;
  return decodeFeeAccount(data);
}

/**
 * Detects the provider-sdk FeeType from on-chain DecodedFeeData.
 *
 * For Leaf data:
 *   - signers !== null → offchainQuotedLinear (asserts Linear strategy)
 *   - signers === null → strategy kind determines type (linear/regressive/progressive)
 * For Routing/CrossCollateralRouting: direct mapping (added in later phases).
 */
export function detectSvmFeeType(feeData: DecodedFeeData): FeeType {
  switch (feeData.kind) {
    case FeeDataKind.Leaf: {
      if (feeData.signers !== null) {
        assert(
          feeData.strategy.kind === FeeStrategyKind.Linear,
          `offchainQuotedLinear requires Linear strategy, got kind ${feeData.strategy.kind}`,
        );
        return FeeType.offchainQuotedLinear;
      }
      switch (feeData.strategy.kind) {
        case FeeStrategyKind.Linear:
          return FeeType.linear;
        case FeeStrategyKind.Regressive:
          return FeeType.regressive;
        case FeeStrategyKind.Progressive:
          return FeeType.progressive;
        default: {
          const _exhaustive: never = feeData.strategy;
          throw new Error(`Unhandled FeeStrategyKind: ${_exhaustive}`);
        }
      }
    }

    case FeeDataKind.Routing:
      return FeeType.routing;

    case FeeDataKind.CrossCollateralRouting:
      return FeeType.crossCollateralRouting;

    default: {
      const _exhaustive: never = feeData;
      throw new Error(`Unhandled FeeDataKind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Fetches and decodes a RouteDomain PDA for a given fee account and domain.
 * Returns null if the account does not exist or is not initialized.
 */
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
  const data = await fetchAccountDataRaw(rpc, routePda);
  if (!data) return null;
  return decodeRouteDomain(data);
}

/**
 * Fetches and decodes a CrossCollateralRoute PDA for a given fee account,
 * destination domain, and target router.
 * Returns null if the account does not exist or is not initialized.
 */
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
  const data = await fetchAccountDataRaw(rpc, ccRoutePda);
  if (!data) return null;
  return decodeCrossCollateralRoute(data);
}
