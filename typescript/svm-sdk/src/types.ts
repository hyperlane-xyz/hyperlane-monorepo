import type {
  Address,
  Instruction,
  ProgramDerivedAddress,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from '@solana/kit';

import type { DeployedHookAddress } from '@hyperlane-xyz/provider-sdk/hook';
import type { DeployedIsmAddress } from '@hyperlane-xyz/provider-sdk/ism';

export type SvmInstruction = Instruction;

export type SvmRpc = Rpc<SolanaRpcApi>;

export interface SvmTransaction {
  instructions: SvmInstruction[];
  computeUnits?: number;
  additionalSigners?: TransactionSigner[];
  /** Skip preflight simulation.
   *  Some transactions that include account creation might fail the simulation check.
   */
  skipPreflight?: boolean;
}

export interface SvmReceipt {
  signature: string;
  slot?: bigint;
}

export type AnnotatedSvmTransaction = SvmTransaction & {
  annotation?: string;
};

/**
 * Specifies how to obtain a deployed program address:
 * - `{ programId }` — use an already-deployed program
 * - `{ programBytes }` — deploy a fresh binary via BPF Loader v3
 */
export type SvmProgramTarget =
  | { programId: Address }
  | { programBytes: Uint8Array };

/** ISM deployed data — the address IS the program. */
export interface SvmDeployedIsm extends DeployedIsmAddress {
  programId: Address;
}

/** Base hook deployed data — references the owning program. */
export interface SvmDeployedHook extends DeployedHookAddress {
  programId: Address;
}

/** IGP hook deployed data — account-level artifact within an IGP program. */
export interface SvmDeployedIgpHook extends SvmDeployedHook {
  igpPda: Address;
  overheadIgpPda?: Address;
}

export interface PdaWithBump {
  pda: ProgramDerivedAddress;
  address: Address;
  bump: number;
}
