//! Fee program instructions.

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
    accounts::FeeData, cc_route_pda_seeds, fee_account_pda_seeds, fee_math::FeeDataStrategy,
    fee_math::FeeParams, fee_standing_quote_pda_seeds, route_domain_pda_seeds,
    transient_quote_pda_seeds,
};

/// Fee program instructions.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initialize a fee account with a salt-derived PDA.
    InitFee(InitFee),
    /// Quote the fee for a transfer. Called via CPI from warp route programs.
    /// Returns fee amount (u64 LE) via set_return_data.
    QuoteFee(QuoteFee),
    /// Set or update the fee strategy for a destination domain (owner-only, Routing mode).
    SetRoute(SetRoute),
    /// Remove a destination domain route, closing the RouteDomain PDA (owner-only).
    RemoveRoute(u32),
    /// Set or update a cross-collateral route (owner-only, CrossCollateralRouting mode).
    SetCrossCollateralRoute(SetCrossCollateralRoute),
    /// Remove a cross-collateral route, closing the CC route PDA (owner-only).
    RemoveCrossCollateralRoute(RemoveCrossCollateralRoute),
    /// Update the fee params on a Leaf fee account (owner-only).
    /// Rejects if the fee account is not FeeData::Leaf.
    UpdateFeeParams(FeeParams),
    /// Set the beneficiary who receives collected fees (owner-only).
    SetBeneficiary(Pubkey),
    /// Transfer ownership of the fee account (owner-only).
    TransferOwnership(Option<Pubkey>),
    /// Add an authorized offchain quote signer (owner-only).
    AddQuoteSigner {
        /// Ethereum address (secp256k1) of the signer to authorize.
        signer: H160,
    },
    /// Remove an offchain quote signer (owner-only).
    RemoveQuoteSigner {
        /// Ethereum address (secp256k1) of the signer to remove.
        signer: H160,
    },
    /// Set the minimum issued_at threshold for standing quote validation (owner-only).
    /// Standing quotes with issued_at < min_issued_at are rejected.
    SetMinIssuedAt {
        /// Unix timestamp; standing quotes issued before this are rejected.
        min_issued_at: i64,
    },
    /// Submit a signed offchain quote (transient or standing).
    /// Transient: fee_account is read-only.
    /// Standing: fee_account must be writable (updates standing_quote_domains on new domain).
    SubmitQuote(SvmSignedQuote),
    /// Close an orphaned transient quote PDA, returning rent to the original payer.
    CloseTransientQuote,
    /// Remove expired standing quotes for a domain, closing the PDA if empty (owner-only).
    /// For CC fee accounts, pass Some(target_router). For Leaf/Routing, pass None.
    PruneExpiredQuotes {
        /// Hyperlane destination domain ID whose standing quote PDA to prune.
        domain: u32,
        /// Remote warp route address for CC accounts; None for Leaf/Routing accounts.
        target_router: Option<H256>,
    },
    /// Simulation-only: returns required account metas for a QuoteFee call.
    GetQuoteAccountMetas(GetQuoteAccountMetas),
    /// Returns the program version via set_return_data. No accounts required.
    GetProgramVersion,
}

impl Instruction {
    /// Deserializes an instruction from a byte slice.
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    /// Serializes an instruction into a byte vector.
    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        borsh::to_vec(&self).map_err(|_| ProgramError::BorshIoError)
    }
}

// --- Instruction data structs ---

/// Initialize a new fee account.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitFee {
    /// Salt for PDA derivation. Allows multiple fee accounts per program.
    pub salt: H256,
    /// Owner who can modify the fee account. None = immutable.
    pub owner: Option<Pubkey>,
    /// Beneficiary who receives collected token fees.
    pub beneficiary: Pubkey,
    /// Fee resolution strategy. The FeeData variant (Leaf/Routing/CrossCollateralRouting)
    /// is immutable after init. Leaf params can be updated via UpdateFeeParams.
    pub fee_data: FeeData,
    /// Hyperlane domain ID of the local chain.
    pub domain_id: u32,
}

/// Quote the fee for a transfer amount to a destination.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct QuoteFee {
    /// Hyperlane domain ID of the destination chain.
    pub destination_domain: u32,
    /// End-user's address on the destination chain.
    pub recipient: H256,
    /// Transfer amount in local token units.
    pub amount: u64,
    /// Remote warp route contract address (used for CC routing resolution).
    /// Ignored for non-CC fee accounts, but always passed for consistent interface.
    pub target_router: H256,
}

/// Set or update a per-domain route (owner-only).
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetRoute {
    /// Hyperlane destination domain ID.
    pub domain: u32,
    /// Fee strategy for this destination domain.
    pub fee_data: FeeDataStrategy,
}

/// Set or update a cross-collateral route (owner-only).
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetCrossCollateralRoute {
    /// Hyperlane destination domain ID.
    pub destination: u32,
    /// Remote warp route contract address.
    pub target_router: H256,
    /// Fee strategy for this (destination, target_router) pair.
    pub fee_data: FeeDataStrategy,
}

/// Remove a cross-collateral route (owner-only).
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct RemoveCrossCollateralRoute {
    /// Hyperlane destination domain ID.
    pub destination: u32,
    /// Remote warp route contract address.
    pub target_router: H256,
}

/// Simulation-only: query required accounts for a QuoteFee call.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct GetQuoteAccountMetas {
    /// Hyperlane destination domain ID.
    pub destination_domain: u32,
    /// Remote warp route contract address (for CC routing).
    pub target_router: H256,
    /// If Some, include the transient quote PDA for this scoped_salt.
    pub scoped_salt: Option<H256>,
}

// --- Instruction builders ---

/// Builds an InitFee instruction.
pub fn init_fee_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    salt: H256,
    owner: Option<Pubkey>,
    beneficiary: Pubkey,
    fee_data: FeeData,
    domain_id: u32,
) -> Result<SolanaInstruction, ProgramError> {
    let (fee_account, _bump) =
        Pubkey::try_find_program_address(fee_account_pda_seeds!(salt), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::InitFee(InitFee {
        salt,
        owner,
        beneficiary,
        fee_data,
        domain_id,
    });

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[signer]` Payer.
    // 2. `[writable]` Fee account PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(payer, true),
        AccountMeta::new(fee_account, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a SetRoute instruction (owner-only).
pub fn set_route_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    domain: u32,
    fee_data: FeeDataStrategy,
) -> Result<SolanaInstruction, ProgramError> {
    let domain_le = domain.to_le_bytes();
    let (route_pda, _bump) = Pubkey::try_find_program_address(
        route_domain_pda_seeds!(fee_account, &domain_le),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SetRoute(SetRoute { domain, fee_data });

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[]` Fee account.
    // 2. `[signer, writable]` Owner.
    // 3. `[writable]` RouteDomain PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(owner, true),
        AccountMeta::new(route_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a RemoveRoute instruction (owner-only).
pub fn remove_route_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    domain: u32,
) -> Result<SolanaInstruction, ProgramError> {
    let domain_le = domain.to_le_bytes();
    let (route_pda, _bump) = Pubkey::try_find_program_address(
        route_domain_pda_seeds!(fee_account, &domain_le),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::RemoveRoute(domain);

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[]` Fee account.
    // 2. `[signer, writable]` Owner.
    // 3. `[writable]` RouteDomain PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(owner, true),
        AccountMeta::new(route_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a SetCrossCollateralRoute instruction (owner-only).
pub fn set_cc_route_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    destination: u32,
    target_router: H256,
    fee_data: FeeDataStrategy,
) -> Result<SolanaInstruction, ProgramError> {
    let dest_le = destination.to_le_bytes();
    let (cc_route_pda, _bump) = Pubkey::try_find_program_address(
        cc_route_pda_seeds!(fee_account, &dest_le, target_router),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SetCrossCollateralRoute(SetCrossCollateralRoute {
        destination,
        target_router,
        fee_data,
    });

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[]` Fee account.
    // 2. `[signer, writable]` Owner.
    // 3. `[writable]` CrossCollateralRoute PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(owner, true),
        AccountMeta::new(cc_route_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a RemoveCrossCollateralRoute instruction (owner-only).
pub fn remove_cc_route_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    destination: u32,
    target_router: H256,
) -> Result<SolanaInstruction, ProgramError> {
    let dest_le = destination.to_le_bytes();
    let (cc_route_pda, _bump) = Pubkey::try_find_program_address(
        cc_route_pda_seeds!(fee_account, &dest_le, target_router),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::RemoveCrossCollateralRoute(RemoveCrossCollateralRoute {
        destination,
        target_router,
    });

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[]` Fee account.
    // 2. `[signer, writable]` Owner.
    // 3. `[writable]` CrossCollateralRoute PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(owner, true),
        AccountMeta::new(cc_route_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds an UpdateFeeParams instruction (owner-only, Leaf mode only).
pub fn update_fee_params_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    fee_params: FeeParams,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::UpdateFeeParams(fee_params);

    // Accounts:
    // 0. `[writable]` Fee account.
    // 1. `[signer]` Owner.
    let accounts = vec![
        AccountMeta::new(fee_account, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a SetBeneficiary instruction (owner-only).
pub fn set_beneficiary_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    new_beneficiary: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetBeneficiary(new_beneficiary);

    // Accounts:
    // 0. `[writable]` Fee account.
    // 1. `[signer]` Owner.
    let accounts = vec![
        AccountMeta::new(fee_account, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a TransferOwnership instruction (owner-only).
pub fn transfer_ownership_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::TransferOwnership(new_owner);

    // Accounts:
    // 0. `[writable]` Fee account.
    // 1. `[signer]` Owner.
    let accounts = vec![
        AccountMeta::new(fee_account, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds an AddQuoteSigner instruction (owner-only).
pub fn add_quote_signer_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    signer: H160,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::AddQuoteSigner { signer };

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[writable]` Fee account.
    // 2. `[signer, writable]` Owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(fee_account, false),
        AccountMeta::new(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a RemoveQuoteSigner instruction (owner-only).
pub fn remove_quote_signer_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    signer: H160,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::RemoveQuoteSigner { signer };

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[writable]` Fee account.
    // 2. `[signer, writable]` Owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(fee_account, false),
        AccountMeta::new(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a SetMinIssuedAt instruction (owner-only).
pub fn set_min_issued_at_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    min_issued_at: i64,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetMinIssuedAt { min_issued_at };

    // Accounts:
    // 0. `[writable]` Fee account.
    // 1. `[signer]` Owner.
    let accounts = vec![
        AccountMeta::new(fee_account, false),
        AccountMeta::new_readonly(owner, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a SubmitQuote instruction for a transient quote.
/// The transient PDA is derived from the fee_account and scoped_salt.
pub fn submit_transient_quote_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    fee_account: Pubkey,
    scoped_salt: H256,
    quote: SvmSignedQuote,
) -> Result<SolanaInstruction, ProgramError> {
    let (transient_pda, _) = Pubkey::try_find_program_address(
        transient_quote_pda_seeds!(fee_account, scoped_salt),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SubmitQuote(quote);

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[signer, writable]` Payer.
    // 2. `[]` Fee account.
    // 3. `[writable]` Transient quote PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(transient_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a SubmitQuote instruction for a standing quote.
/// For Leaf/Routing fee accounts, pass `target_router = H256::zero()`.
/// For CC fee accounts, pass the actual target_router.
pub fn submit_standing_quote_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    fee_account: Pubkey,
    domain: u32,
    target_router: H256,
    quote: SvmSignedQuote,
) -> Result<SolanaInstruction, ProgramError> {
    let domain_le = domain.to_le_bytes();
    let (standing_pda, _) = Pubkey::try_find_program_address(
        fee_standing_quote_pda_seeds!(fee_account, &domain_le, target_router),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SubmitQuote(quote);

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[signer, writable]` Payer.
    // 2. `[writable]` Fee account (updated with standing_quote_domains on new domain).
    // 3. `[writable]` Standing quote PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(payer, true),
        AccountMeta::new(fee_account, false),
        AccountMeta::new(standing_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a CloseTransientQuote instruction.
pub fn close_transient_quote_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    transient_pda: Pubkey,
    payer_refund: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::CloseTransientQuote;

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[]` Fee account.
    // 2. `[writable]` Transient quote PDA.
    // 3. `[signer]` Original payer (receives rent refund).
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(transient_pda, false),
        AccountMeta::new(payer_refund, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a PruneExpiredQuotes instruction.
/// For Leaf/Routing fee accounts, pass `target_router = None`.
/// For CC fee accounts, pass `Some(target_router)`.
pub fn prune_expired_quotes_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    domain: u32,
    target_router: Option<H256>,
) -> Result<SolanaInstruction, ProgramError> {
    let domain_le = domain.to_le_bytes();
    let resolved_router = target_router.unwrap_or(H256::zero());
    let (standing_pda, _) = Pubkey::try_find_program_address(
        fee_standing_quote_pda_seeds!(fee_account, &domain_le, resolved_router),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::PruneExpiredQuotes {
        domain,
        target_router,
    };

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[writable]` Fee account.
    // 2. `[signer, writable]` Owner.
    // 3. `[writable]` Standing quote PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(fee_account, false),
        AccountMeta::new(owner, true),
        AccountMeta::new(standing_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a GetProgramVersion instruction. No accounts required.
pub fn get_program_version_instruction(
    program_id: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::GetProgramVersion;

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts: vec![],
    })
}
