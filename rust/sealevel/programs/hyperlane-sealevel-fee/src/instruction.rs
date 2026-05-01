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

use std::collections::BTreeSet;

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
    /// Set or update a remote fee route (owner-only).
    /// For Routing: pass target_router = None.
    /// For CC: pass target_router = Some(router), rejects H256::zero().
    /// Closes any existing standing quote PDA for the (domain, target_router) pair.
    SetRemoteFeeRoute(SetRemoteFeeRoute),
    /// Remove a remote fee route, closing the route PDA (owner-only).
    /// Also closes any standing quote PDA for the (domain, target_router) pair.
    RemoveRemoteFeeRoute(RemoveRemoteFeeRoute),
    /// Update the fee params on a Leaf fee account (owner-only).
    /// Rejects if the fee account is not FeeData::Leaf.
    UpdateFeeParams(FeeParams),
    /// Set the beneficiary who receives collected fees (owner-only).
    SetBeneficiary(Pubkey),
    /// Transfer ownership of the fee account (owner-only).
    TransferOwnership(Option<Pubkey>),
    /// Add or remove an authorized offchain quote signer (owner-only).
    /// For Leaf: route = None (mutates FeeAccount.signers).
    /// For Routing: route = Some(Domain(d)) (mutates RouteDomain.signers).
    /// For CC: route = Some(CrossCollateral { .. }) (mutates CrossCollateralRoute.signers).
    SetQuoteSigner {
        /// Add or remove operation with the signer address.
        operation: SetQuoteSignerOperation,
        /// Route key for PDA derivation. None targets FeeAccount (Leaf mode).
        route: Option<RouteKey>,
    },
    /// Set the minimum issued_at threshold for standing quote validation (owner-only).
    /// Standing quotes with issued_at < min_issued_at are rejected.
    SetMinIssuedAt {
        /// Unix timestamp; standing quotes issued before this are rejected.
        min_issued_at: i64,
    },
    /// Set wildcard quote signers for Routing or CrossCollateralRouting modes (owner-only).
    /// Mutates the wildcard_signers field inside the FeeData variant on the FeeAccount.
    /// Rejects Leaf mode (use AddQuoteSigner with route=None instead).
    /// Pass an empty set to disable wildcard quoting.
    SetWildcardQuoteSigners {
        /// New wildcard signer set. Empty = no wildcard quoting.
        signers: BTreeSet<H160>,
    },
    /// Submit a signed offchain quote (transient or standing).
    /// Fee account is always read-only.
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
    /// Simulation-only: returns required account metas for a SubmitQuote call.
    GetSubmitQuoteAccountMetas(GetSubmitQuoteAccountMetas),
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

// --- Route key for signer mutation dispatch ---

/// Identifies which route PDA to target for signer management.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub enum RouteKey {
    /// Target a RouteDomain PDA (Routing mode).
    Domain(u32),
    /// Target a CrossCollateralRoute PDA (CC mode).
    CrossCollateral {
        /// Hyperlane destination domain ID.
        destination: u32,
        /// Remote warp route contract address.
        target_router: H256,
    },
}

/// Operation for adding or removing a quote signer.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum SetQuoteSignerOperation {
    /// Add the signer to the authorized set.
    Add(H160),
    /// Remove the signer from the authorized set.
    Remove(H160),
}

impl SetQuoteSignerOperation {
    /// Returns the signer address regardless of the operation variant.
    pub fn signer(&self) -> &H160 {
        match self {
            Self::Add(s) | Self::Remove(s) => s,
        }
    }
}

// --- Instruction data structs ---

/// Initialize a new fee account.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitFee {
    /// Salt for PDA derivation. Allows multiple fee accounts per program.
    pub salt: H256,
    /// Beneficiary who receives collected token fees.
    pub beneficiary: Pubkey,
    /// Fee resolution strategy with variant-specific signer configuration.
    /// The FeeData variant (Leaf/Routing/CrossCollateralRouting)
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

/// Set or update a remote fee route (owner-only).
/// For Routing mode: target_router = None (uses RouteDomain PDA).
/// For CC mode: target_router = Some(router) (uses CrossCollateralRoute PDA).
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetRemoteFeeRoute {
    /// Hyperlane destination domain ID.
    pub domain: u32,
    /// Remote warp route address. None for Routing, Some for CC.
    pub target_router: Option<H256>,
    /// Fee strategy for this route.
    pub fee_data: FeeDataStrategy,
    /// Authorized offchain quote signers for this route.
    /// Some = offchain quoting enabled, None = on-chain fee only.
    pub signers: Option<BTreeSet<H160>>,
}

/// Remove a remote fee route (owner-only).
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct RemoveRemoteFeeRoute {
    /// Hyperlane destination domain ID.
    pub domain: u32,
    /// Remote warp route address. None for Routing, Some for CC.
    pub target_router: Option<H256>,
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

/// Simulation-only: query required accounts for a SubmitQuote call.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct GetSubmitQuoteAccountMetas {
    /// Hyperlane destination domain ID (from quote context).
    pub destination_domain: u32,
    /// Remote warp route contract address (for CC routing).
    pub target_router: H256,
    /// If Some, returns accounts for a transient quote (scoped_salt needed for PDA derivation).
    /// If None, returns accounts for a standing quote.
    pub scoped_salt: Option<H256>,
}

// --- Instruction builders ---

/// Builds an InitFee instruction.
pub fn init_fee_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    salt: H256,
    beneficiary: Pubkey,
    fee_data: FeeData,
    domain_id: u32,
) -> Result<SolanaInstruction, ProgramError> {
    let (fee_account, _bump) =
        Pubkey::try_find_program_address(fee_account_pda_seeds!(salt), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::InitFee(InitFee {
        salt,
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

/// Builds a SetRemoteFeeRoute instruction (owner-only).
/// For Routing: pass target_router = None.
/// For CC: pass target_router = Some(router).
pub fn set_remote_fee_route_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    domain: u32,
    target_router: Option<H256>,
    fee_data: FeeDataStrategy,
    signers: Option<BTreeSet<H160>>,
) -> Result<SolanaInstruction, ProgramError> {
    let domain_le = domain.to_le_bytes();
    let route_pda = derive_route_pda_from_target_router(
        &program_id,
        &fee_account,
        &domain_le,
        target_router.as_ref(),
    )?;
    let standing_target = target_router.unwrap_or(H256::zero());
    let (standing_pda, _) = Pubkey::try_find_program_address(
        fee_standing_quote_pda_seeds!(fee_account, &domain_le, standing_target),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SetRemoteFeeRoute(SetRemoteFeeRoute {
        domain,
        target_router,
        fee_data,
        signers,
    });

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[]` Fee account.
    // 2. `[signer, writable]` Owner.
    // 3. `[writable]` Route PDA (RouteDomain or CrossCollateralRoute).
    // 4. `[writable]` Standing quote PDA (created empty or overwritten to empty).
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(owner, true),
        AccountMeta::new(route_pda, false),
        AccountMeta::new(standing_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a RemoveRemoteFeeRoute instruction (owner-only).
/// For Routing: pass target_router = None.
/// For CC: pass target_router = Some(router).
pub fn remove_remote_fee_route_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    domain: u32,
    target_router: Option<H256>,
) -> Result<SolanaInstruction, ProgramError> {
    let domain_le = domain.to_le_bytes();
    let route_pda = derive_route_pda_from_target_router(
        &program_id,
        &fee_account,
        &domain_le,
        target_router.as_ref(),
    )?;
    let standing_target = target_router.unwrap_or(H256::zero());
    let (standing_pda, _) = Pubkey::try_find_program_address(
        fee_standing_quote_pda_seeds!(fee_account, &domain_le, standing_target),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::RemoveRemoteFeeRoute(RemoveRemoteFeeRoute {
        domain,
        target_router,
    });

    // Accounts:
    // 0. `[]` Fee account.
    // 1. `[signer, writable]` Owner (receives rent refund).
    // 2. `[writable]` Route PDA.
    // 3. `[writable]` Standing quote PDA (closed if it exists).
    let accounts = vec![
        AccountMeta::new_readonly(fee_account, false),
        AccountMeta::new(owner, true),
        AccountMeta::new(route_pda, false),
        AccountMeta::new(standing_pda, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Derives the route PDA from an optional target_router.
/// None → RouteDomain PDA, Some → CrossCollateralRoute PDA.
fn derive_route_pda_from_target_router(
    program_id: &Pubkey,
    fee_account: &Pubkey,
    domain_le: &[u8; 4],
    target_router: Option<&H256>,
) -> Result<Pubkey, ProgramError> {
    match target_router {
        None => Pubkey::try_find_program_address(
            route_domain_pda_seeds!(fee_account, domain_le),
            program_id,
        )
        .map(|(key, _)| key)
        .ok_or(ProgramError::InvalidSeeds),
        Some(router) => Pubkey::try_find_program_address(
            cc_route_pda_seeds!(fee_account, domain_le, router),
            program_id,
        )
        .map(|(key, _)| key)
        .ok_or(ProgramError::InvalidSeeds),
    }
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

/// Builds a SetQuoteSigner instruction (owner-only).
/// For Leaf mode: pass `route = None` (mutates FeeAccount.signers).
/// For Routing: pass `route = Some(RouteKey::Domain(d))`.
/// For CC: pass `route = Some(RouteKey::CrossCollateral { .. })`.
pub fn set_quote_signer_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    operation: SetQuoteSignerOperation,
    route: Option<RouteKey>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetQuoteSigner {
        operation,
        route: route.clone(),
    };

    // Leaf (route=None): fee_account writable (signers live there).
    // Routed (route=Some): fee_account readonly (signers live on route PDA).
    let fee_account_writable = route.is_none();
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        if fee_account_writable {
            AccountMeta::new(fee_account, false)
        } else {
            AccountMeta::new_readonly(fee_account, false)
        },
        AccountMeta::new(owner, true),
    ];

    if let Some(ref route_key) = route {
        let route_pda = derive_route_pda(&program_id, &fee_account, route_key)?;
        accounts.push(AccountMeta::new(route_pda, false));
    }

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Derives the route PDA address for a given RouteKey.
fn derive_route_pda(
    program_id: &Pubkey,
    fee_account: &Pubkey,
    route_key: &RouteKey,
) -> Result<Pubkey, ProgramError> {
    match route_key {
        RouteKey::Domain(domain) => {
            let domain_le = domain.to_le_bytes();
            Pubkey::try_find_program_address(
                route_domain_pda_seeds!(fee_account, &domain_le),
                program_id,
            )
            .map(|(key, _)| key)
            .ok_or(ProgramError::InvalidSeeds)
        }
        RouteKey::CrossCollateral {
            destination,
            target_router,
        } => {
            let dest_le = destination.to_le_bytes();
            Pubkey::try_find_program_address(
                cc_route_pda_seeds!(fee_account, &dest_le, target_router),
                program_id,
            )
            .map(|(key, _)| key)
            .ok_or(ProgramError::InvalidSeeds)
        }
    }
}

/// Builds a SetWildcardQuoteSigners instruction (owner-only).
/// Only valid for Routing and CrossCollateralRouting fee accounts.
pub fn set_wildcard_quote_signers_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    signers: BTreeSet<H160>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::SetWildcardQuoteSigners { signers };

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
/// For Routing/CC fee accounts, pass `route_pdas` with the route PDA(s) for signer lookup.
/// For Leaf, pass an empty slice.
pub fn submit_transient_quote_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    fee_account: Pubkey,
    scoped_salt: H256,
    quote: SvmSignedQuote,
    route_pdas: &[Pubkey],
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
    // 3..N. `[]` Route PDAs (Routing: 1 RouteDomain, CC: specific + default CC route).
    // N+1. `[writable]` Transient quote PDA.
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(fee_account, false),
    ];
    for pda in route_pdas {
        accounts.push(AccountMeta::new_readonly(*pda, false));
    }
    accounts.push(AccountMeta::new(transient_pda, false));

    Ok(SolanaInstruction {
        program_id,
        data: borsh::to_vec(&ixn)?,
        accounts,
    })
}

/// Builds a SubmitQuote instruction for a standing quote.
/// For Leaf/Routing fee accounts, pass `target_router = H256::zero()`.
/// For CC fee accounts, pass the actual target_router.
/// For Routing/CC fee accounts, pass `route_pdas` with the route PDA(s) for signer lookup.
/// For Leaf, pass an empty slice.
pub fn submit_standing_quote_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    fee_account: Pubkey,
    domain: u32,
    target_router: H256,
    quote: SvmSignedQuote,
    route_pdas: &[Pubkey],
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
    // 2. `[]` Fee account (read-only).
    // 3..N. `[]` Route PDAs (Routing: 1 RouteDomain, CC: specific + default CC route).
    // N+1. `[writable]` Standing quote PDA.
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(fee_account, false),
    ];
    for pda in route_pdas {
        accounts.push(AccountMeta::new_readonly(*pda, false));
    }
    accounts.push(AccountMeta::new(standing_pda, false));

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
    // 0. `[]` Fee account.
    // 1. `[writable]` Transient quote PDA.
    // 2. `[signer]` Original payer (receives rent refund).
    let accounts = vec![
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
/// Uses a universal discriminator shared across all Hyperlane SVM programs.
pub fn get_program_version_instruction(
    program_id: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    Ok(SolanaInstruction {
        program_id,
        data: package_versioned::get_program_version_instruction_data(),
        accounts: vec![],
    })
}
