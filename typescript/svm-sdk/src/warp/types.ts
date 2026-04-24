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
  /** Salt for fee account PDA derivation. Resolved from chain name by the artifact manager. */
  feeSalt: Uint8Array;
}>;

/**
 * SVM-specific extension of DeployedWarpAddress that carries the
 * on-chain fee configuration (both program ID and fee account PDA).
 *
 * Used for accurate fee config diffing during updates — the same fee
 * program with a different salt produces a different fee account PDA.
 */
export interface SvmDeployedWarpAddress extends DeployedWarpAddress {
  feeConfig?: TokenFeeConfig;
}
