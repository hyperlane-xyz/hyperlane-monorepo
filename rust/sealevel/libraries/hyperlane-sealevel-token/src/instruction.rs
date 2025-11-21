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

use hyperlane_sealevel_mailbox::mailbox_message_dispatch_authority_pda_seeds;

use crate::hyperlane_token_pda_seeds;

/// Instructions shared by all Hyperlane Sealevel Token programs.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initialize the program.
    Init(Init),
    /// Transfer tokens to a remote recipient.
    TransferRemote(TransferRemote),
    /// Enroll a remote router. Only owner.
    EnrollRemoteRouter(RemoteRouterConfig),
    /// Enroll multiple remote routers. Only owner.
    EnrollRemoteRouters(Vec<RemoteRouterConfig>),
    /// Enroll multiple remote routers. Only owner.
    SetDestinationGasConfigs(Vec<GasRouterConfig>),
    /// Set the interchain security module. Only owner.
    SetInterchainSecurityModule(Option<Pubkey>),
    /// Set the interchain gas paymaster program and account. Only owner.
    SetInterchainGasPaymaster(Option<(Pubkey, InterchainGasPaymasterType)>),
    /// Transfer ownership of the program. Only owner.
    TransferOwnership(Option<Pubkey>),
}

impl DiscriminatorData for Instruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}

// ~~~~~~~~~~~~~~~~ DYMENSION ~~~~~~~~~~~~~~~~~~

/// Instruction data for transferring `amount_or_id` token to `recipient`
/// on `destination` domain, including a memo.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemoteMemo {
    /// Base transfer instruction.
    pub base: TransferRemote,
    /// Arbitrary metadata.
    pub memo: Vec<u8>,
}

/// Instructions specifically for this token program
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum DymInstruction {
    /// Transfer tokens to a remote recipient, including a memo.
    TransferRemoteMemo(TransferRemoteMemo),
}

impl DiscriminatorData for DymInstruction {
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
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
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
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
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
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
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
