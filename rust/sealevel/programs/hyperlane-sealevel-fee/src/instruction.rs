use account_utils::{DiscriminatorData, DiscriminatorEncode, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{accounts::FeeData, fee_pda_seeds, fee_route_pda_seeds};

/// Instructions for the Hyperlane Sealevel Fee program.
///
/// The fee program manages fee accounts that define how transfer fees are
/// computed for warp route transfers. Fee accounts are PDAs derived from a
/// user-provided salt, enabling deterministic addresses.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum FeeInstruction {
    /// Create a new fee account PDA with the given salt and fee parameters.
    /// The payer becomes the initial owner.
    InitFee(InitFee),
    /// Set a per-domain route on a Routing fee account. Creates or overwrites
    /// the route domain PDA. Only callable by the fee account owner.
    SetRoute(SetRoute),
    /// Remove a per-domain route, closing the route domain PDA and returning
    /// rent to the specified recipient. Only callable by the fee account owner.
    RemoveRoute(u32),
    /// Update the fee parameters on an existing fee account. May trigger a
    /// realloc if the new FeeData variant has a different serialized size.
    /// Only callable by the fee account owner.
    UpdateFeeData(FeeData),
    /// Update the beneficiary address on an existing fee account.
    /// Only callable by the fee account owner.
    SetBeneficiary(Pubkey),
    /// Transfer ownership of a fee account. Pass `None` to renounce ownership
    /// (makes the fee account immutable). Only callable by the current owner.
    TransferOwnership(Option<Pubkey>),
    /// Quote a fee amount for a given destination domain and transfer amount.
    /// Called by warp routes via CPI. Returns the fee as u64 LE bytes via
    /// `set_return_data`.
    QuoteFee(QuoteFee),
}

impl DiscriminatorData for FeeInstruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}

/// Data for InitFee instruction.
///
/// The fee account PDA is derived from `(fee_pda_seeds, salt)`. Using
/// different salts allows multiple fee accounts under the same program.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitFee {
    /// Salt used to derive the fee account PDA. Allows creating multiple
    /// fee accounts with different configurations.
    pub salt: H256,
    /// The wallet address that receives collected fees.
    pub beneficiary: Pubkey,
    /// The fee configuration (Linear, Regressive, Progressive, or Routing).
    pub fee_data: FeeData,
}

/// Data for SetRoute instruction.
///
/// Creates or overwrites a route domain PDA that maps a destination domain
/// to inlined fee parameters.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetRoute {
    /// The destination domain to route.
    pub domain: u32,
    /// The fee configuration data for this domain.
    pub fee_data: FeeData,
}

/// Data for QuoteFee instruction.
///
/// Used by warp routes via CPI to determine the fee for a transfer.
/// The fee program computes the fee based on the fee account's FeeData
/// and returns it as u64 LE bytes via `set_return_data`.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct QuoteFee {
    /// The destination domain for the transfer.
    pub destination_domain: u32,
    /// The transfer amount in local token units.
    pub amount: u64,
}

// ---- Instruction builders ----

/// Creates an InitFee instruction.
pub fn init_fee_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    salt: H256,
    beneficiary: Pubkey,
    fee_data: FeeData,
) -> Result<SolanaInstruction, ProgramError> {
    let (fee_key, _) = Pubkey::try_find_program_address(fee_pda_seeds!(salt), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = FeeInstruction::InitFee(InitFee {
        salt,
        beneficiary,
        fee_data,
    });

    // Accounts:
    // 0. `[executable]` System program
    // 1. `[writable]` Fee account PDA
    // 2. `[signer]` Payer / owner
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(fee_key, false),
        AccountMeta::new(payer, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    })
}

/// Creates a SetRoute instruction.
pub fn set_route_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    fee_account: Pubkey,
    domain: u32,
    fee_data: FeeData,
) -> Result<SolanaInstruction, ProgramError> {
    let (route_pda, _) =
        Pubkey::try_find_program_address(fee_route_pda_seeds!(fee_account, domain), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = FeeInstruction::SetRoute(SetRoute { domain, fee_data });

    // Accounts:
    // 0. `[executable]` System program
    // 1. `[writable]` Fee account PDA
    // 2. `[writable]` Route domain PDA
    // 3. `[signer]` Owner
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(route_pda, false),
        AccountMeta::new(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    })
}

/// Creates a RemoveRoute instruction.
pub fn remove_route_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    fee_account: Pubkey,
    domain: u32,
) -> Result<SolanaInstruction, ProgramError> {
    let (route_pda, _) =
        Pubkey::try_find_program_address(fee_route_pda_seeds!(fee_account, domain), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = FeeInstruction::RemoveRoute(domain);

    // Accounts:
    // 0. `[writable]` Fee account PDA
    // 1. `[writable]` Route domain PDA
    // 2. `[signer]` Owner
    // 3. `[writable]` Rent recipient (gets back lamports)
    let accounts = vec![
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(route_pda, false),
        AccountMeta::new_readonly(owner, true),
        AccountMeta::new(owner, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    })
}

/// Creates an UpdateFeeData instruction.
pub fn update_fee_data_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    fee_account: Pubkey,
    fee_data: FeeData,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = FeeInstruction::UpdateFeeData(fee_data);

    // Accounts:
    // 0. `[executable]` System program
    // 1. `[writable]` Fee account PDA
    // 2. `[signer]` Owner
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(fee_account, false),
        AccountMeta::new(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    })
}

/// Creates a TransferOwnership instruction.
pub fn transfer_ownership_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    fee_account: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = FeeInstruction::TransferOwnership(new_owner);

    // Accounts:
    // 0. `[writable]` Fee account PDA
    // 1. `[signer]` Current owner
    let accounts = vec![
        AccountMeta::new(fee_account, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    })
}

/// Creates a SetBeneficiary instruction.
pub fn set_beneficiary_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    fee_account: Pubkey,
    new_beneficiary: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = FeeInstruction::SetBeneficiary(new_beneficiary);

    // Accounts:
    // 0. `[writable]` Fee account PDA
    // 1. `[signer]` Owner
    let accounts = vec![
        AccountMeta::new(fee_account, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    })
}

/// Creates a QuoteFee instruction.
pub fn quote_fee_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    destination_domain: u32,
    amount: u64,
    additional_accounts: Vec<AccountMeta>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = FeeInstruction::QuoteFee(QuoteFee {
        destination_domain,
        amount,
    });

    let mut accounts = vec![AccountMeta::new_readonly(fee_account, false)];
    accounts.extend(additional_accounts);

    Ok(SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    })
}
