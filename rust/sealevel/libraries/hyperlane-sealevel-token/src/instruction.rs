//! Instructions shared by all Hyperlane Sealevel Token programs.

use account_utils::{DiscriminatorData, DiscriminatorEncode, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H256, U256};
use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;
use std::fmt::Debug;

use hyperlane_sealevel_mailbox::mailbox_message_dispatch_authority_pda_seeds;

use crate::{hyperlane_token_factory_state_pda_seeds, hyperlane_token_pda_seeds};

/// Instructions shared by all Hyperlane Sealevel Token programs.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    // ── Per-program (legacy) instructions — indices 0-7, unchanged ──────────
    /// Initialize the program (old per-program model).
    Init(Init),
    /// Transfer tokens to a remote recipient (old per-program model).
    TransferRemote(TransferRemote),
    /// Enroll a remote router. Only owner.
    EnrollRemoteRouter(RemoteRouterConfig),
    /// Enroll multiple remote routers. Only owner.
    EnrollRemoteRouters(Vec<RemoteRouterConfig>),
    /// Set destination gas configs. Only owner.
    SetDestinationGasConfigs(Vec<GasRouterConfig>),
    /// Set the interchain security module. Only owner.
    SetInterchainSecurityModule(Option<Pubkey>),
    /// Set the interchain gas paymaster program and account. Only owner.
    SetInterchainGasPaymaster(Option<(Pubkey, InterchainGasPaymasterType)>),
    /// Transfer ownership of the program. Only owner.
    TransferOwnership(Option<Pubkey>),

    // ── Factory instructions — indices 8+ ────────────────────────────────────
    /// Initialize this program as a factory (creates the factory state PDA).
    /// Must be called once before any `CreateRoute` calls.
    InitFactory(InitFactory),
    /// Create a new warp route instance within this factory.
    CreateRoute(CreateRoute),
    /// Enroll remote routers for a factory route (also creates lookup PDAs).
    EnrollRemoteRoutersForRoute(EnrollRemoteRoutersForRoute),
    /// Set destination gas configs for a factory route.
    SetDestinationGasConfigsForRoute(SetDestinationGasConfigsForRoute),
    /// Set the ISM for a factory route. Only route owner.
    /// Note: the route's ISM overrides the factory-level ISM only for admin
    /// bookkeeping — the on-chain ISM query still returns the factory-level ISM.
    SetInterchainSecurityModuleForRoute(SetWithSalt<Option<Pubkey>>),
    /// Set the IGP for a factory route. Only route owner.
    SetInterchainGasPaymasterForRoute(SetWithSalt<Option<(Pubkey, InterchainGasPaymasterType)>>),
    /// Transfer ownership of a factory route. Only current owner.
    TransferOwnershipForRoute(SetWithSalt<Option<Pubkey>>),
    /// Transfer tokens to a remote recipient from a factory route.
    TransferRemoteFromRoute(TransferRemoteFromRoute),
    /// Set the factory-level ISM. Only factory owner.
    SetFactoryInterchainSecurityModule(Option<Pubkey>),
    /// Transfer ownership of the factory itself. Only current factory owner.
    TransferFactoryOwnership(Option<Pubkey>),
}

impl DiscriminatorData for Instruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}

/// Instruction data for initializing the program.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct Init {
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The interchain security module.
    pub interchain_security_module: Option<Pubkey>,
    /// The interchain gas paymaster program and account.
    pub interchain_gas_paymaster: Option<(Pubkey, InterchainGasPaymasterType)>,
    /// The local decimals.
    pub decimals: u8,
    /// The remote decimals.
    pub remote_decimals: u8,
}

/// Instruction data for transferring `amount_or_id` token to `recipient` on `destination` domain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemote {
    /// The destination domain.
    pub destination_domain: u32,
    /// The remote recipient.
    pub recipient: H256,
    /// The amount or ID of the token to transfer.
    pub amount_or_id: U256,
}

// ── Factory instruction data types ──────────────────────────────────────────

/// Instruction data for initializing a factory.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitFactory {
    /// The interchain security module shared by all routes in this factory.
    pub interchain_security_module: Option<Pubkey>,
}

/// Instruction data for creating a new route within a factory.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct CreateRoute {
    /// 32-byte salt — uniquely identifies this route within the factory.
    pub salt: [u8; 32],
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The interchain security module for this route (stored in route state;
    /// does not affect on-chain ISM queries which use the factory-level ISM).
    pub interchain_security_module: Option<Pubkey>,
    /// The interchain gas paymaster for this route.
    pub interchain_gas_paymaster: Option<(Pubkey, InterchainGasPaymasterType)>,
    /// The local token decimals.
    pub decimals: u8,
    /// The remote token decimals.
    pub remote_decimals: u8,
}

/// Instruction data for enrolling remote routers on a factory route.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct EnrollRemoteRoutersForRoute {
    /// The route salt.
    pub salt: [u8; 32],
    /// Router configs to enroll.
    pub configs: Vec<RemoteRouterConfig>,
}

/// Instruction data for setting destination gas configs on a factory route.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetDestinationGasConfigsForRoute {
    /// The route salt.
    pub salt: [u8; 32],
    /// Gas configs to set.
    pub configs: Vec<GasRouterConfig>,
}

/// Generic wrapper pairing a `salt` with any value for route-scoped set instructions.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetWithSalt<T: BorshDeserialize + BorshSerialize + Debug> {
    /// The route salt.
    pub salt: [u8; 32],
    /// The value to set.
    pub value: T,
}

/// Instruction data for transferring tokens from a factory route.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemoteFromRoute {
    /// The route salt.
    pub salt: [u8; 32],
    /// The destination domain.
    pub destination_domain: u32,
    /// The remote recipient.
    pub recipient: H256,
    /// The amount or ID of the token to transfer.
    pub amount_or_id: U256,
}

/// Gets an instruction to initialize the program. This provides only the
/// account metas required by the library, and consuming programs are expected
/// to add the accounts for their own use.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    init: Init,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let (dispatch_authority_key, _dispatch_authority_bump) = Pubkey::try_find_program_address(
        mailbox_message_dispatch_authority_pda_seeds!(),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::Init(init);

    // Accounts:
    // 0.   `[executable]` The system program.
    // 1.   `[writable]` The token PDA account.
    // 2.   `[writable]` The dispatch authority PDA account.
    // 3.   `[signer]` The payer and access control owner.
    // 4..N `[??..??]` Plugin-specific accounts.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(token_key, false),
        AccountMeta::new(dispatch_authority_key, false),
        AccountMeta::new(payer, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

/// Enrolls remote routers.
pub fn enroll_remote_routers_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    configs: Vec<RemoteRouterConfig>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::EnrollRemoteRouters(configs);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The token PDA account.
    // 2. `[signer]` The owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(token_key, false),
        AccountMeta::new(owner_payer, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

/// Sets destination gas configs.
pub fn set_destination_gas_configs(
    program_id: Pubkey,
    owner_payer: Pubkey,
    configs: Vec<GasRouterConfig>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SetDestinationGasConfigs(configs);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The token PDA account.
    // 2. `[signer]` The owner.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(token_key, false),
        AccountMeta::new(owner_payer, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

/// Transfers ownership.
pub fn transfer_ownership_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::TransferOwnership(new_owner);

    // Accounts:
    // 0. `[writeable]` The token PDA account.
    // 1. `[signer]` The current owner.
    let accounts = vec![
        AccountMeta::new(token_key, false),
        AccountMeta::new_readonly(owner_payer, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to set the ISM.
pub fn set_interchain_security_module_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    new_interchain_security_module: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SetInterchainSecurityModule(new_interchain_security_module);

    // Accounts:
    // 0. `[writeable]` The token PDA account.
    // 1. `[signer]` The current owner.
    let accounts = vec![
        AccountMeta::new(token_key, false),
        AccountMeta::new_readonly(owner_payer, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

/// Sets the igp for a warp route
pub fn set_igp_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    igp_program_and_account: Option<(Pubkey, InterchainGasPaymasterType)>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::SetInterchainGasPaymaster(igp_program_and_account);

    // Accounts:
    // 0. `[writeable]` The token PDA account.
    // 1. `[signer]` The current owner.
    let accounts = vec![
        AccountMeta::new(token_key, false),
        AccountMeta::new_readonly(owner_payer, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

// ── Factory instruction builders ─────────────────────────────────────────────

/// Builds an `InitFactory` instruction.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writable]` Factory state PDA.
/// 2. `[signer]` Payer / owner.
pub fn init_factory_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    init: InitFactory,
) -> Result<SolanaInstruction, ProgramError> {
    let (factory_state_key, _bump) =
        Pubkey::try_find_program_address(hyperlane_token_factory_state_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(factory_state_key, false),
        AccountMeta::new(payer, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::InitFactory(init).encode()?,
        accounts,
    })
}

/// Builds a `CreateRoute` instruction.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writable]` Factory state PDA (validates factory is initialized).
/// 2. `[writable]` Route PDA (to be created).
/// 3. `[writable]` Dispatch authority PDA (to be created).
/// 4. `[signer]` Payer / route owner.
///
/// Plus plugin-specific accounts (depends on plugin type).
pub fn create_route_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    create_route: CreateRoute,
    plugin_accounts: Vec<AccountMeta>,
) -> Result<SolanaInstruction, ProgramError> {
    use crate::hyperlane_token_route_pda_seeds;

    let (factory_state_key, _) =
        Pubkey::try_find_program_address(hyperlane_token_factory_state_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let (route_pda_key, _) = Pubkey::try_find_program_address(
        hyperlane_token_route_pda_seeds!(&create_route.salt),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let (dispatch_authority_key, _) = Pubkey::try_find_program_address(
        mailbox_message_dispatch_authority_pda_seeds!(),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(factory_state_key, false),
        AccountMeta::new(route_pda_key, false),
        AccountMeta::new(dispatch_authority_key, false),
        AccountMeta::new(payer, true),
    ];
    accounts.extend(plugin_accounts);

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::CreateRoute(create_route).encode()?,
        accounts,
    })
}

/// Builds an `EnrollRemoteRoutersForRoute` instruction.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writable]` Route PDA.
/// 2. `[signer]` Owner / payer.
///
/// 3+. `[writable]` One lookup PDA per enrolled router config.
pub fn enroll_remote_routers_for_route_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    data: EnrollRemoteRoutersForRoute,
    lookup_pda_keys: Vec<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    use crate::hyperlane_token_route_pda_seeds;

    let (route_pda_key, _) =
        Pubkey::try_find_program_address(hyperlane_token_route_pda_seeds!(&data.salt), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(route_pda_key, false),
        AccountMeta::new(owner_payer, true),
    ];
    for key in lookup_pda_keys {
        accounts.push(AccountMeta::new(key, false));
    }

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::EnrollRemoteRoutersForRoute(data).encode()?,
        accounts,
    })
}
