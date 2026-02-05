//! HelloWorld instructions.

use borsh::{BorshDeserialize, BorshSerialize};

#[allow(unused_imports)]
use crate::types::{
    InterchainGasPaymasterType, InterchainGasPaymasterTypeProxy, RemoteRouterConfig,
    RemoteRouterConfigProxy,
};
use shank::{ShankInstruction, ShankType};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::program_storage_pda_seeds;

/// Init instruction data.
#[derive(BorshSerialize, BorshDeserialize, Debug, ShankType)]
pub struct Init {
    /// The local domain.
    pub local_domain: u32,
    /// The mailbox.
    pub mailbox: Pubkey,
    /// The ISM.
    pub ism: Option<Pubkey>,
    /// The IGP.
    #[idl_type("Option<(Pubkey, InterchainGasPaymasterTypeProxy)>")]
    pub igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    /// The owner.
    pub owner: Option<Pubkey>,
}

/// A HelloWorld message.
#[derive(BorshSerialize, BorshDeserialize, Debug, ShankType)]
pub struct HelloWorldMessage {
    /// The destination domain.
    pub destination: u32,
    /// The message.
    pub message: String,
}

/// Instructions for the program.
#[derive(BorshSerialize, BorshDeserialize, Debug, ShankInstruction)]
#[rustfmt::skip]
pub enum HelloWorldInstruction {
    /// Initializes the program.
    #[account(0, name = "system_program", desc = "System program")]
    #[account(1, signer, name = "payer", desc = "Payer")]
    #[account(2, writable, name = "program_storage", desc = "Program storage PDA")]
    Init(Init),

    /// Dispatches a message using the dispatch authority.
    #[account(0, writable, name = "program_storage", desc = "Program storage")]
    #[account(1, name = "mailbox_program", desc = "Mailbox program")]
    #[account(2, writable, name = "mailbox_outbox", desc = "Mailbox outbox PDA")]
    #[account(3, name = "dispatch_authority", desc = "Dispatch authority PDA")]
    #[account(4, name = "system_program", desc = "System program")]
    #[account(5, name = "spl_noop", desc = "SPL Noop program")]
    #[account(6, signer, name = "payer", desc = "Payer")]
    #[account(7, signer, name = "unique_message", desc = "Unique message account")]
    #[account(8, writable, name = "dispatched_message", desc = "Dispatched message PDA")]
    SendHelloWorld(HelloWorldMessage),

    /// Sets the ISM.
    #[account(0, writable, name = "program_storage", desc = "Program storage PDA")]
    #[account(1, signer, name = "owner", desc = "Owner")]
    SetInterchainSecurityModule(Option<Pubkey>),

    /// Enrolls remote routers
    #[account(0, name = "system_program", desc = "System program")]
    #[account(1, writable, name = "program_storage", desc = "Program storage PDA")]
    #[account(2, signer, name = "owner", desc = "Owner")]
    #[idl_type("Vec<RemoteRouterConfigProxy>")]
    EnrollRemoteRouters(Vec<RemoteRouterConfig>),
}

/// Gets an instruction to initialize the program.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    local_domain: u32,
    mailbox: Pubkey,
    ism: Option<Pubkey>,
    igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    owner: Option<Pubkey>,
) -> Result<Instruction, ProgramError> {
    let (program_storage_account, _program_storage_bump) =
        Pubkey::try_find_program_address(program_storage_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let init = Init {
        local_domain,
        mailbox,
        ism,
        igp,
        owner,
    };

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[signer]` Payer.
    // 2. `[writeable]` Storage PDA.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(program_storage_account, false),
    ];

    let instruction = Instruction {
        program_id,
        data: HelloWorldInstruction::Init(init).try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to enroll remote routers.
pub fn enroll_remote_routers_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    configs: Vec<RemoteRouterConfig>,
) -> Result<Instruction, ProgramError> {
    let (program_storage_account, _program_storage_bump) =
        Pubkey::try_find_program_address(program_storage_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    // Accounts:
    // 0. `[executable]` System program.
    // 1. `[signer]` Payer.
    // 2. `[writeable]` Storage PDA.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new(program_storage_account, false),
        AccountMeta::new(owner, true),
    ];

    let instruction = Instruction {
        program_id,
        data: HelloWorldInstruction::EnrollRemoteRouters(configs).try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to set the interchain security module.
pub fn set_interchain_security_module_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    ism: Option<Pubkey>,
) -> Result<Instruction, ProgramError> {
    let (program_storage_account, _program_storage_bump) =
        Pubkey::try_find_program_address(program_storage_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    // Accounts:
    // 0. `[writeable]` Storage PDA account.
    // 1. `[signer]` Owner.
    let accounts = vec![
        AccountMeta::new(program_storage_account, false),
        AccountMeta::new(owner, true),
    ];

    let instruction = Instruction {
        program_id,
        data: HelloWorldInstruction::SetInterchainSecurityModule(ism).try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}
