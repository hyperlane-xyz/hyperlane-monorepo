import type { SvmProgramTarget } from '../types.js';

/**
 * Deployment-time configuration for the SVM mailbox.
 * Passed to the writer constructor; separate from the on-chain artifact config.
 */
export type SvmMailboxConfig = Readonly<{
  /** How to obtain the deployed program: fresh bytes or pre-existing ID. */
  program: SvmProgramTarget;
  /** The local domain ID for this mailbox. */
  domainId: number;
}>;

/**
 * Deployment-time configuration for the SVM validator announce.
 * Passed to the writer constructor; separate from the on-chain artifact config.
 */
export type SvmValidatorAnnounceConfig = Readonly<{
  /** How to obtain the deployed program: fresh bytes or pre-existing ID. */
  program: SvmProgramTarget;
  /** The local domain ID for this validator announce. */
  domainId: number;
}>;
