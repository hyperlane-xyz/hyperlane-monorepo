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

use hyperlane_core::H160 as SignerAddress;

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
    /// For Leaf: route = None (mutates FeeAccount.signers).
    /// For Routing: route = Some(Domain(d)) (mutates RouteDomain.signers).
    /// For CC: route = Some(CrossCollateral { .. }) (mutates CrossCollateralRoute.signers).
    AddQuoteSigner {
        /// Ethereum address (secp256k1) of the signer to authorize.
        signer: H160,
        /// Route key for PDA derivation. None targets FeeAccount (Leaf mode).
        route: Option<RouteKey>,
    },
    /// Remove an offchain quote signer (owner-only).
    /// Same routing semantics as AddQuoteSigner.
    RemoveQuoteSigner {
        /// Ethereum address (secp256k1) of the signer to remove.
        signer: H160,
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
        signers: BTreeSet<SignerAddress>,
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
    /// Simulation-only: returns required account metas for a SubmitQuote call.
    GetSubmitQuoteAccountMetas(GetSubmitQuoteAccountMetas),
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

/// Set or update a per-domain route (owner-only).
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetRoute {
    /// Hyperlane destination domain ID.
    pub domain: u32,
    /// Fee strategy for this destination domain.
    pub fee_data: FeeDataStrategy,
    /// Authorized offchain quote signers for this route.
    /// Some = offchain quoting enabled, None = on-chain fee only.
    pub signers: Option<BTreeSet<SignerAddress>>,
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
    /// Authorized offchain quote signers for this route.
    /// Some = offchain quoting enabled, None = on-chain fee only.
    pub signers: Option<BTreeSet<SignerAddress>>,
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
    signers: Option<BTreeSet<SignerAddress>>,
) -> Result<SolanaInstruction, ProgramError> {
    let domain_le = domain.to_le_bytes();
    let (route_pda, _bump) = Pubkey::try_find_program_address(
        route_domain_pda_seeds!(fee_account, &domain_le),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SetRoute(SetRoute {
        domain,
        fee_data,
        signers,
    });

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
    signers: Option<BTreeSet<SignerAddress>>,
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
        signers,
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
/// For Leaf mode: pass `route = None` (mutates FeeAccount.signers).
/// For Routing: pass `route = Some(RouteKey::Domain(d))`.
/// For CC: pass `route = Some(RouteKey::CrossCollateral { .. })`.
pub fn add_quote_signer_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    signer: H160,
    route: Option<RouteKey>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::AddQuoteSigner {
        signer,
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

/// Builds a RemoveQuoteSigner instruction (owner-only).
/// Same routing semantics as add_quote_signer_instruction.
pub fn remove_quote_signer_instruction(
    program_id: Pubkey,
    fee_account: Pubkey,
    owner: Pubkey,
    signer: H160,
    route: Option<RouteKey>,
) -> Result<SolanaInstruction, ProgramError> {
    let ixn = Instruction::RemoveQuoteSigner {
        signer,
        route: route.clone(),
    };

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
    signers: BTreeSet<SignerAddress>,
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
/// `fee_account_writable`: true for Leaf/Routing (updates standing_quote_domains), false for CC.
pub fn submit_standing_quote_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    fee_account: Pubkey,
    domain: u32,
    target_router: H256,
    quote: SvmSignedQuote,
    route_pdas: &[Pubkey],
    fee_account_writable: bool,
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
    // 2. `[writable/readonly]` Fee account (writable for Leaf/Routing, readonly for CC).
    // 3..N. `[]` Route PDAs (Routing: 1 RouteDomain, CC: specific + default CC route).
    // N+1. `[writable]` Standing quote PDA.
    let fee_account_meta = if fee_account_writable {
        AccountMeta::new(fee_account, false)
    } else {
        AccountMeta::new_readonly(fee_account, false)
    };
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(payer, true),
        fee_account_meta,
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
