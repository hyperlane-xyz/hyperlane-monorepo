//! HelloWorld instructions.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::program_storage_pda_seeds;

/// Init instruction data.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Init {
    /// The local domain.
    pub local_domain: u32,
    /// The mailbox.
    pub mailbox: Pubkey,
    /// The ISM.
    pub ism: Option<Pubkey>,
    /// The IGP.
    pub igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    /// The owner.
    pub owner: Option<Pubkey>,
}

/// CallRemote instruction data.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct CallRemoteMessage {
    /// The destination domain of the account.
    pub destination: u32,
    /// The ism to use on the destination domain.
    pub ism: Option<H256>,
    /// The salt to use for account derivation.
    pub salt: Option<H256>,
    /// The gas limit to use for the calls.
    pub gas_limit: u64,
    /// The abi-encoded calls
    pub calls: Vec<u8>,
}

/// Instructions for the program.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum InterchainAccountInstruction {
    /// Initializes the program.
    Init(Init),
    /// Dispatches a message using the dispatch authority.
    CallRemote(CallRemoteMessage),
    /// Sets the ISM.
    SetInterchainSecurityModule(Option<Pubkey>),
    /// Enrolls remote routers
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
        data: InterchainAccountInstruction::Init(init).try_to_vec()?,
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
        data: InterchainAccountInstruction::EnrollRemoteRouters(configs).try_to_vec()?,
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
        data: InterchainAccountInstruction::SetInterchainSecurityModule(ism).try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}
