import type { DeployedWarpAddress } from '@hyperlane-xyz/provider-sdk/warp';

import type { TokenFeeConfig } from '../accounts/token.js';
import type { SvmProgramTarget } from '../types.js';

/**
 * Deployment-time configuration for any SVM warp token.
 * Passed to writer constructors; separate from the on-chain artifact config.
 */
export type SvmWarpTokenConfig = Readonly<{
  /** How to obtain the deployed program: fresh bytes or pre-existing ID. */
  program: SvmProgramTarget;
  /**
   * Lamports to ensure the ATA payer PDA holds after deployment.
   * Required for synthetic and collateral tokens to pay for recipient ATA
   * creation on transfer_out.
   */
  ataPayerFundingAmount: bigint;
  /** Salt for fee account PDA derivation. Resolved from chain name if not provided. */
  feeSalt?: Uint8Array;
}>;

/**
 * SVM-specific extension of DeployedWarpAddress that carries the
 * on-chain fee configuration (both program ID and fee account PDA).
 * Used for accurate fee config diffing during updates.
 *
 * Note: cross-VM tooling that round-trips through the bare
 * `IRawWarpArtifactManager` / `DeployedWarpAddress` shape will drop
 * the `feeConfig` field. This is intentional — at apply time the SVM
 * reader re-fetches the on-chain truth before diffing, so the artifact
 * doesn't need to round-trip the field for correctness.
 */
export interface SvmDeployedWarpAddress extends DeployedWarpAddress {
  feeConfig?: TokenFeeConfig;
}
