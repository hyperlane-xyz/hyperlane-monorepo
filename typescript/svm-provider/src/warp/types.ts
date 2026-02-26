import type { Address } from '@solana/kit';

import type { SvmProgramTarget } from '../types.js';

/**
 * Deployment-time configuration for any SVM warp token.
 * Passed to writer constructors; separate from the on-chain artifact config.
 */
export type SvmWarpTokenConfig = Readonly<{
  /** How to obtain the deployed program: fresh bytes or pre-existing ID. */
  program: SvmProgramTarget;
  /** The IGP program used as the default hook (needed for create and update). */
  igpProgramId: Address;
  /**
   * Lamports to ensure the ATA payer PDA holds after deployment.
   * Required for synthetic and collateral tokens to pay for recipient ATA
   * creation on transfer_out.
   */
  ataPayerFundingAmount: bigint;
}>;
