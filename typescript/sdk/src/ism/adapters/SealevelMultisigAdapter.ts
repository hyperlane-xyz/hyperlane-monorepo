import {
  AccountMeta,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { serialize } from 'borsh';

import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import {
  SealevelMultisigIsmInstructionType,
  SealevelMultisigIsmSetValidatorsInstruction,
  SealevelMultisigIsmSetValidatorsInstructionSchema,
  SealevelMultisigIsmTransferOwnershipInstruction,
  SealevelMultisigIsmTransferOwnershipInstructionSchema,
} from '../../ism/serialization.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { SealevelInstructionWrapper } from '../../utils/sealevelSerialization.js';

export class SealevelMultisigAdapter extends BaseSealevelAdapter {
  protected readonly multisigIsm: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { multisigIsm: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.multisigIsm = new PublicKey(addresses.multisigIsm);
  }

  /*
   * Instruction builders for MultisigIsm operations
   * Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs
   */

  /**
   * Create a SetValidatorsAndThreshold instruction
   * @param multisigIsmProgramId - The MultisigIsm program ID
   * @param accessControlPda - The access control PDA account
   * @param domainDataPda - The domain data PDA account (will be created if doesn't exist)
   * @param owner - The current owner who can set validators
   * @param domain - The remote domain for which validators are being set
   * @param validators - Array of 20-byte validator addresses (Ethereum-style addresses)
   * @param threshold - The number of validator signatures required
   * @returns TransactionInstruction
   */
  createSetValidatorsAndThresholdInstruction(
    multisigIsmProgramId: PublicKey,
    accessControlPda: PublicKey,
    domainDataPda: PublicKey,
    owner: PublicKey,
    domain: Domain,
    validators: Uint8Array[],
    threshold: number,
  ): TransactionInstruction {
    // Validate that all validators are 20 bytes (Ethereum addresses)
    validators.forEach((validator, index) => {
      if (validator.length !== 20) {
        throw new Error(
          `Validator at index ${index} must be 20 bytes, got ${validator.length}`,
        );
      }
    });

    const keys: AccountMeta[] = [
      // 0. `[signer]` The access control owner and payer of the domain PDA.
      { pubkey: owner, isSigner: true, isWritable: true },
      // 1. `[]` The access control PDA account.
      { pubkey: accessControlPda, isSigner: false, isWritable: false },
      // 2. `[writable]` The PDA relating to the provided domain.
      { pubkey: domainDataPda, isSigner: false, isWritable: true },
      // 3. `[executable]` OPTIONAL - The system program account. Required if creating the domain PDA.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const value = new SealevelInstructionWrapper({
      instruction:
        SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD,
      data: new SealevelMultisigIsmSetValidatorsInstruction({
        domain,
        validators,
        threshold,
      }),
    });

    const data = Buffer.from(
      serialize(SealevelMultisigIsmSetValidatorsInstructionSchema, value),
    );

    return new TransactionInstruction({
      keys,
      programId: multisigIsmProgramId,
      data,
    });
  }

  /**
   * Create a TransferOwnership instruction
   * @param multisigIsmProgramId - The MultisigIsm program ID
   * @param accessControlPda - The access control PDA account
   * @param owner - The current owner
   * @param newOwner - The new owner (null to renounce ownership)
   * @returns TransactionInstruction
   */
  createTransferOwnershipInstruction(
    multisigIsmProgramId: PublicKey,
    accessControlPda: PublicKey,
    owner: PublicKey,
    newOwner: PublicKey | null,
  ): TransactionInstruction {
    const keys: AccountMeta[] = [
      // 0. `[signer]` The current access control owner.
      { pubkey: owner, isSigner: true, isWritable: true },
      // 1. `[writeable]` The access control PDA account.
      { pubkey: accessControlPda, isSigner: false, isWritable: true },
    ];

    const value = new SealevelInstructionWrapper({
      instruction: SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP,
      data: new SealevelMultisigIsmTransferOwnershipInstruction({
        newOwner: newOwner ? newOwner.toBuffer() : null,
      }),
    });

    const data = Buffer.from(
      serialize(SealevelMultisigIsmTransferOwnershipInstructionSchema, value),
    );

    return new TransactionInstruction({
      keys,
      programId: multisigIsmProgramId,
      data,
    });
  }

  /**
   * Helper method to convert hex string validators to Uint8Array format
   * @param hexValidators - Array of validator addresses as hex strings (with or without 0x prefix)
   * @returns Array of 20-byte Uint8Arrays
   */
  static hexValidatorsToUint8Array(hexValidators: string[]): Uint8Array[] {
    return hexValidators.map((hex) => {
      const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
      if (cleaned.length !== 40) {
        throw new Error(
          `Validator address must be 40 hex characters (20 bytes), got ${cleaned.length}`,
        );
      }
      return Uint8Array.from(Buffer.from(cleaned, 'hex'));
    });
  }

  /*
   * PDA derivation methods
   * Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/ism/multisig-ism-message-id/src/pda_seeds.rs
   */

  /**
   * Derive the domain data PDA for a given domain
   * Matches: rust/sealevel/programs/ism/multisig-ism-message-id/src/processor.rs domain_data_pda_seeds!
   * @param multisigIsmProgramId - The MultisigIsm program ID
   * @param domain - The domain
   * @returns PublicKey for the domain data PDA
   */
  static deriveDomainDataPda(
    multisigIsmProgramId: string | PublicKey,
    domain: Domain,
  ): PublicKey {
    const domainBuffer = Buffer.alloc(4);
    domainBuffer.writeUInt32LE(domain, 0);
    return super.derivePda(
      ['multisig_ism_message_id', '-', domainBuffer, '-', 'domain_data'],
      multisigIsmProgramId,
    );
  }

  /**
   * Derive the access control PDA
   * Matches: rust/sealevel/programs/ism/multisig-ism-message-id/src/processor.rs access_control_pda_seeds!
   * @param multisigIsmProgramId - The MultisigIsm program ID
   * @returns PublicKey for the access control PDA
   */
  static deriveAccessControlPda(
    multisigIsmProgramId: string | PublicKey,
  ): PublicKey {
    return super.derivePda(
      ['multisig_ism_message_id', '-', 'access_control'],
      multisigIsmProgramId,
    );
  }
}
