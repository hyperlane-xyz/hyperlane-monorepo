//! Program instructions.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H160, H256};
use quote_verifier::SvmSignedQuote;

use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{GasOracle, IgpFeeConfig, InterchainGasPaymasterType},
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
    /// Sets or removes the IGP quote configuration.
    /// Some(config) → sets fee_config (operator controls all fields).
    /// None → removes fee_config (disables quoting).
    SetIgpQuoteConfig(Option<IgpFeeConfig>),
    /// Adds or removes an authorized quote signer on the IGP.
    /// Requires fee_config to be set via SetIgpQuoteConfig first.
    SetIgpQuoteSigner(SetIgpQuoteSignerOperation),
    /// Sets the min_issued_at threshold on the IGP.
    /// Monotonic: new value must be >= current value.
    /// Requires fee_config to be set via SetIgpQuoteConfig first.
    SetIgpMinIssuedAt(i64),
    /// Submits an offchain-signed quote to the IGP.
    /// Standing (expiry > issued_at) or transient (expiry == issued_at).
    SubmitIgpQuote(SvmSignedQuote),
    /// Closes an orphaned transient quote PDA, refunding rent to the stored payer.
    CloseIgpTransientQuote,
    /// Closes an expired standing quote PDA, refunding rent to the IGP's beneficiary.
    CloseIgpStandingQuote,
}

/// Operation for adding or removing a quote signer.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum SetIgpQuoteSignerOperation {
    /// Add the signer to the authorized set.
    Add(H160),
    /// Remove the signer from the authorized set.
    Remove(H160),
}

impl Instruction {
    /// Deserializes an instruction from a slice.
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    /// Serializes an instruction into a vector of bytes.
    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        borsh::to_vec(&self).map_err(|_| ProgramError::BorshIoError)
    }
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
    // 0. `[executable]` The system program.
    // 1. `[signer]` The payer account.
    // 2. `[writeable]` The program data PDA account.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(program_data_account, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
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
    // 0. `[executable]` The system program.
    // 1. `[signer]` The payer account.
    // 2. `[writeable]` The IGP account to initialize.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(igp_account, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
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
    // 0. `[executable]` The system program.
    // 1. `[signer]` The payer account.
    // 2. `[writeable]` The IGP account to initialize.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(igp_account, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
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
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[signer]` The IGP owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(overhead_igp, false),
        AccountMeta::new(owner, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
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
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[signer]` The IGP owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(igp, false),
        AccountMeta::new(owner, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
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
    // 0. `[executable]` The system program.
    // 1. `[signer]` The payer.
    // 2. `[writeable]` The IGP program data.
    // 3. `[signer]` Unique gas payment account.
    // 4. `[writeable]` Gas payment PDA.
    // 5. `[writeable]` The IGP account.
    // 6. `[]` Overhead IGP account (optional).
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
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
        data: borsh::to_vec(&ixn)?,
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

    // 0. `[writeable]` The IGP or OverheadIGP.
    // 1. `[signer]` The owner of the IGP account.
    let instruction = SolanaInstruction {
        program_id,
        data: borsh::to_vec(&instruction)?,
        accounts: vec![
            AccountMeta::new(igp_account, false),
            AccountMeta::new(owner_payer, true),
        ],
    };
    Ok(instruction)
}

/// Gets an instruction to claim funds from an IGP to the beneficiary.
pub fn claim_instruction(
    program_id: Pubkey,
    igp: Pubkey,
    beneficiary: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::Claim;

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[writeable]` The IGP beneficiary.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(igp, false),
        AccountMeta::new(beneficiary, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to claim funds from an IGP to the beneficiary.
pub fn set_beneficiary_instruction(
    program_id: Pubkey,
    igp: Pubkey,
    igp_owner: Pubkey,
    new_beneficiary: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetIgpBeneficiary(new_beneficiary);

    // Accounts:
    // 0. `[]` The IGP.
    // 1. `[signer]` The owner of the IGP account.
    let accounts = vec![
        AccountMeta::new(igp, false),
        AccountMeta::new(igp_owner, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to set or remove the IGP quote configuration.
pub fn set_igp_quote_config_instruction(
    program_id: Pubkey,
    igp: Pubkey,
    owner: Pubkey,
    config: Option<IgpFeeConfig>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetIgpQuoteConfig(config);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[signer]` The IGP owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(igp, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Gets an instruction to add or remove an authorized quote signer on an IGP.
pub fn set_igp_quote_signer_instruction(
    program_id: Pubkey,
    igp: Pubkey,
    owner: Pubkey,
    operation: SetIgpQuoteSignerOperation,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetIgpQuoteSigner(operation);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[signer]` The IGP owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(igp, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Gets an instruction to set the min_issued_at threshold on an IGP.
pub fn set_igp_min_issued_at_instruction(
    program_id: Pubkey,
    igp: Pubkey,
    owner: Pubkey,
    min_issued_at: i64,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetIgpMinIssuedAt(min_issued_at);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[signer]` The IGP owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(igp, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Gets an instruction to submit an offchain-signed quote to the IGP.
pub fn submit_igp_quote_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    igp: Pubkey,
    quote_pda: Pubkey,
    quote: SvmSignedQuote,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SubmitIgpQuote(quote);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[signer, writeable]` The payer.
    // 2. `[]` The IGP account.
    // 3. `[writeable]` The quote PDA (standing or transient).
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(igp, false),
        AccountMeta::new(quote_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Gets an instruction to close an orphaned transient quote PDA.
pub fn close_igp_transient_quote_instruction(
    program_id: Pubkey,
    transient_pda: Pubkey,
    payer: Pubkey,
    igp: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::CloseIgpTransientQuote;

    // Accounts:
    // 0. `[writeable]` The transient quote PDA.
    // 1. `[signer, writeable]` The payer (must match stored payer).
    // 2. `[]` The IGP account (for PDA re-derivation).
    let accounts = vec![
        AccountMeta::new(transient_pda, false),
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(igp, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Gets an instruction to close an expired standing quote PDA.
pub fn close_igp_standing_quote_instruction(
    program_id: Pubkey,
    standing_pda: Pubkey,
    igp: Pubkey,
    beneficiary: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::CloseIgpStandingQuote;

    // Accounts:
    // 0. `[writeable]` The standing quote PDA.
    // 1. `[]` The IGP account (for PDA re-derivation + beneficiary check).
    // 2. `[writeable]` The beneficiary (receives rent refund).
    let accounts = vec![
        AccountMeta::new(standing_pda, false),
        AccountMeta::new_readonly(igp, false),
        AccountMeta::new(beneficiary, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}
