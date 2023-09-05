//! Program instructions.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;

use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    accounts::{GasOracle, InterchainGasPaymasterType},
    igp_gas_payment_pda_seeds, igp_pda_seeds, igp_program_data_pda_seeds, overhead_igp_pda_seeds,
};

/// The program instructions.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    Init,
    /// Initializes an IGP.
    InitIgp(InitIgp),
    /// Initializes an overhead IGP.
    InitOverheadIgp(InitOverheadIgp),
    /// Pays for gas.
    PayForGas(PayForGas),
    /// Quotes a gas payment.
    QuoteGasPayment(QuoteGasPayment),
    /// Transfers ownership of an IGP.
    TransferIgpOwnership(Option<Pubkey>),
    /// Transfers ownership of an overhead IGP.
    TransferOverheadIgpOwnership(Option<Pubkey>),
    /// Sets the beneficiary of an IGP.
    SetIgpBeneficiary(Pubkey),
    /// Sets destination gas overheads on an overhead IGP.
    SetDestinationGasOverheads(Vec<GasOverheadConfig>),
    /// Sets gas oracles on an IGP.
    SetGasOracleConfigs(Vec<GasOracleConfig>),
    /// Claims lamports from an IGP, sending them to the IGP's beneficiary.
    Claim,
}

/// Initializes an IGP.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitIgp {
    /// A salt used for deriving the IGP PDA.
    pub salt: H256,
    /// The owner of the IGP.
    pub owner: Option<Pubkey>,
    /// The beneficiary of the IGP.
    pub beneficiary: Pubkey,
}

/// Initializes an overhead IGP.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitOverheadIgp {
    /// A salt used for deriving the overhead IGP PDA.
    pub salt: H256,
    /// The owner of the overhead IGP.
    pub owner: Option<Pubkey>,
    /// The inner IGP.
    pub inner: Pubkey,
}

/// Pays for gas.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct PayForGas {
    /// The message ID.
    pub message_id: H256,
    /// The destination domain.
    pub destination_domain: u32,
    /// The gas amount.
    pub gas_amount: u64,
}

/// Quotes a gas payment.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct QuoteGasPayment {
    /// The destination domain.
    pub destination_domain: u32,
    /// The gas amount.
    pub gas_amount: u64,
}

/// A config for setting a destination gas overhead.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct GasOverheadConfig {
    /// The destination domain.
    pub destination_domain: u32,
    /// The gas overhead.
    pub gas_overhead: Option<u64>,
}

/// A config for setting remote gas data.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct GasOracleConfig {
    /// The destination domain.
    pub domain: u32,
    /// The gas oracle.
    pub gas_oracle: Option<GasOracle>,
}

/// Gets an instruction to initialize the program.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (program_data_account, _program_data_bump) =
        Pubkey::try_find_program_address(igp_program_data_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::Init;

    // Accounts:
    // 0. [executable] The system program.
    // 1. [signer] The payer account.
    // 2. [writeable] The program data PDA account.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(program_data_account, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to initialize an IGP account.
pub fn init_igp_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    salt: H256,
    owner: Option<Pubkey>,
    beneficiary: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (igp_account, _igp_bump) =
        Pubkey::try_find_program_address(igp_pda_seeds!(salt), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::InitIgp(InitIgp {
        salt,
        owner,
        beneficiary,
    });

    // Accounts:
    // 0. [executable] The system program.
    // 1. [signer] The payer account.
    // 2. [writeable] The IGP account to initialize.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(igp_account, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to initialize an overhead IGP account.
pub fn init_overhead_igp_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    salt: H256,
    owner: Option<Pubkey>,
    inner: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (igp_account, _igp_bump) =
        Pubkey::try_find_program_address(overhead_igp_pda_seeds!(salt), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::InitOverheadIgp(InitOverheadIgp { salt, owner, inner });

    // Accounts:
    // 0. [executable] The system program.
    // 1. [signer] The payer account.
    // 2. [writeable] The IGP account to initialize.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(igp_account, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to set the destination gas overheads.
pub fn set_destination_gas_overheads(
    program_id: Pubkey,
    overhead_igp: Pubkey,
    owner: Pubkey,
    overhead_gas_amounts: Vec<GasOverheadConfig>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetDestinationGasOverheads(overhead_gas_amounts);

    // Accounts:
    // 0. [executable] The system program.
    // 1. [writeable] The IGP.
    // 2. [signer] The IGP owner.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new(overhead_igp, false),
        AccountMeta::new(owner, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to set gas oracles.
pub fn set_gas_oracle_configs_instruction(
    program_id: Pubkey,
    igp: Pubkey,
    owner: Pubkey,
    gas_oracle_configs: Vec<GasOracleConfig>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetGasOracleConfigs(gas_oracle_configs);

    // Accounts:
    // 0. [executable] The system program.
    // 1. [writeable] The IGP.
    // 2. [signer] The IGP owner.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new(igp, false),
        AccountMeta::new(owner, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to pay for gas
#[allow(clippy::too_many_arguments)]
pub fn pay_for_gas_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    igp: Pubkey,
    overhead_igp: Option<Pubkey>,
    unique_gas_payment_account_pubkey: Pubkey,
    message_id: H256,
    destination_domain: u32,
    gas_amount: u64,
) -> Result<(SolanaInstruction, Pubkey), ProgramError> {
    let (program_data_account, _program_data_bump) =
        Pubkey::try_find_program_address(igp_program_data_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;
    let (gas_payment_account, _gas_payment_bump) = Pubkey::try_find_program_address(
        igp_gas_payment_pda_seeds!(unique_gas_payment_account_pubkey),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::PayForGas(PayForGas {
        message_id,
        destination_domain,
        gas_amount,
    });

    // Accounts:
    // 0. [executable] The system program.
    // 1. [signer] The payer.
    // 2. [writeable] The IGP program data.
    // 3. [signer] Unique gas payment account.
    // 4. [writeable] Gas payment PDA.
    // 5. [writeable] The IGP account.
    // 6. [] Overhead IGP account (optional).
    let mut accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new(payer, true),
        AccountMeta::new(program_data_account, false),
        AccountMeta::new_readonly(unique_gas_payment_account_pubkey, true),
        AccountMeta::new(gas_payment_account, false),
        AccountMeta::new(igp, false),
    ];
    if let Some(overhead_igp) = overhead_igp {
        accounts.push(AccountMeta::new_readonly(overhead_igp, false));
    }

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.try_to_vec()?,
        accounts,
    };

    Ok((instruction, gas_payment_account))
}

/// Gets an instruction to change an IGP or Overhead IGP
/// account's owner.
pub fn transfer_igp_account_ownership_instruction(
    program_id: Pubkey,
    igp_account_type: InterchainGasPaymasterType,
    owner_payer: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (igp_account, instruction) = match igp_account_type {
        InterchainGasPaymasterType::Igp(igp_account) => {
            (igp_account, Instruction::TransferIgpOwnership(new_owner))
        }
        InterchainGasPaymasterType::OverheadIgp(igp_account) => (
            igp_account,
            Instruction::TransferOverheadIgpOwnership(new_owner),
        ),
    };

    // 0. [writeable] The IGP or OverheadIGP.
    // 1. [signer] The owner of the IGP account.
    let instruction = SolanaInstruction {
        program_id,
        data: instruction.try_to_vec()?,
        accounts: vec![
            AccountMeta::new(igp_account, false),
            AccountMeta::new(owner_payer, true),
        ],
    };
    Ok(instruction)
}
