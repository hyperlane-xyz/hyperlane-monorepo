use account_utils::{DiscriminatorData, DiscriminatorEncode, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{error::Error, storage_pda_seeds};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    ///
    /// Accounts:
    /// 0. `[signer]` The new owner and payer of the storage PDA.
    /// 1. `[writable]` The storage PDA account.
    /// 2. `[executable]` The system program account.
    Initialize(Pubkey),
    /// Sets the trusted relayer.
    ///
    /// Accounts:
    /// 0. `[signer]` The access control owner.
    /// 1. `[writable]` The storage PDA account.
    SetRelayer(Pubkey),
    /// Gets the owner from the storage account.
    ///
    /// Accounts:
    /// 0. `[]` The storage PDA account.
    GetOwner,
    /// Sets the owner in the storage account.
    ///
    /// Accounts:
    /// 0. `[signer]` The current owner.
    /// 1. `[writable]` The storage PDA account.
    TransferOwnership(Option<Pubkey>),
}

impl DiscriminatorData for Instruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}

impl TryFrom<&[u8]> for Instruction {
    type Error = ProgramError;

    fn try_from(data: &[u8]) -> Result<Self, Self::Error> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }
}

pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    relayer: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    let accounts = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new(storage_pda_key, false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::Initialize(relayer).encode()?,
        accounts,
    })
}

pub fn set_relayer_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    relayer: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::find_program_address(storage_pda_seeds!(), &program_id);

    let accounts = vec![
        AccountMeta::new(owner, true),
        AccountMeta::new(storage_pda_key, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::SetRelayer(relayer).encode()?,
        accounts,
    })
}

pub fn transfer_ownership_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::find_program_address(storage_pda_seeds!(), &program_id);

    let accounts = vec![
        AccountMeta::new(owner, true),
        AccountMeta::new(storage_pda_key, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::TransferOwnership(new_owner).encode()?,
        accounts,
    })
}

/// Returns the account metas needed for `Verify`.
/// The relayer account must be a signer in the transaction.
///
/// Accounts required for `VerifyAccountMetas`:
/// 0. `[]` The storage PDA account.
pub fn verify_account_metas_instruction(
    program_id: Pubkey,
    metadata: Vec<u8>,
    message: Vec<u8>,
) -> Result<SolanaInstruction, ProgramError> {
    use hyperlane_sealevel_interchain_security_module_interface::{
        InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
    };

    let (storage_pda_key, _) = Pubkey::find_program_address(storage_pda_seeds!(), &program_id);
    let (vam_pda_key, _) =
        Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &program_id);

    let accounts = vec![
        AccountMeta::new_readonly(vam_pda_key, false),
        AccountMeta::new_readonly(storage_pda_key, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction {
            metadata,
            message,
        })
        .encode()
        .map_err(|_| Error::AccountOutOfOrder)?,
        accounts,
    })
}
