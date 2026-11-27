//! Router instructions and client builders.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_mailbox::{
    mailbox_dispatched_message_pda_seeds, mailbox_message_dispatch_authority_pda_seeds,
    mailbox_outbox_pda_seeds,
};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{accounts::config_address, message::Call};

/// Outbound convenience call using the enrolled router and ISM, with zero salt.
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct CallRemote {
    /// Destination Hyperlane domain.
    pub destination: u32,
    /// Calls executed on the destination.
    pub calls: Vec<Call>,
}

/// A destination's router and ISM defaults, enrolled together as on EVM.
#[derive(BorshDeserialize, BorshSerialize, Debug, Clone)]
pub struct RemoteRouterAndIsm {
    /// Destination Hyperlane domain.
    pub domain: u32,
    /// Destination ICA router.
    pub router: H256,
    /// Destination ISM; zero selects the destination mailbox default.
    pub ism: H256,
}

/// Outbound call parameters, equivalent to EVM `callRemoteWithOverrides`.
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct CallRemoteWithOverrides {
    /// Destination Hyperlane domain.
    pub destination: u32,
    /// Destination ICA router.
    pub router: H256,
    /// Destination ISM; zero selects the destination default.
    pub ism: H256,
    /// Calls, supplied directly in instruction data.
    pub calls: Vec<Call>,
    /// User salt for destination account derivation.
    pub salt: H256,
}

/// Instructions supported in addition to the Hyperlane recipient interface.
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub enum Instruction {
    /// Initializes configuration, authorized by the program upgrade authority.
    Init,
    /// Dispatches calls. The owner comes from the signer account, never instruction data.
    CallRemoteWithOverrides(CallRemoteWithOverrides),
    /// Dispatches through the enrolled router/ISM with zero salt, matching EVM `callRemote`.
    CallRemote(CallRemote),
    /// Enrolls a router with a zero ISM. Owner only.
    EnrollRemoteRouter(u32, H256),
    /// Batch router enrollment with zero ISMs. Owner only.
    EnrollRemoteRouters(Vec<(u32, H256)>),
    /// Enrolls router and ISM defaults together. Owner only.
    EnrollRemoteRouterAndIsm(RemoteRouterAndIsm),
    /// Batch enrollment of router and ISM defaults. Owner only.
    EnrollRemoteRouterAndIsms(Vec<RemoteRouterAndIsm>),
    /// Removes an enrolled router without clearing its ISM. Owner only.
    UnenrollRemoteRouter(u32),
    /// Batch router removal. Owner only.
    UnenrollRemoteRouters(Vec<u32>),
    /// Transfers or renounces ownership (`None`), following the Hyp token pattern.
    TransferOwnership(Option<Pubkey>),
    /// Returns the owner as `SimulationReturnData<Option<Pubkey>>`.
    GetOwner,
    /// Returns the enrolled router or zero as `SimulationReturnData<H256>`.
    Routers(u32),
    /// Returns the outgoing ISM or zero as `SimulationReturnData<H256>`.
    Isms(u32),
    /// Returns enrolled domains in ascending order as `SimulationReturnData<Vec<u32>>`.
    Domains,
}

/// Builds an owner-only configuration instruction: system, config, owner/payer.
/// The owner funds rent increases, matching Hyp token enrollment.
pub fn router_config_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    instruction: Instruction,
) -> Result<SolanaInstruction, ProgramError> {
    Ok(SolanaInstruction::new_with_bytes(
        program_id,
        &borsh::to_vec(&instruction)?,
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(config_address(&program_id).0, false),
            AccountMeta::new(owner, true),
        ],
    ))
}

/// Builds the router initialization instruction.
pub fn init_instruction(
    program_id: Pubkey,
    mailbox: Pubkey,
    payer: Pubkey,
    upgrade_authority: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    Ok(SolanaInstruction::new_with_bytes(
        program_id,
        &borsh::to_vec(&Instruction::Init)?,
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(payer, true),
            AccountMeta::new(config_address(&program_id).0, false),
            AccountMeta::new_readonly(
                solana_loader_v3_interface::get_program_data_address(&program_id),
                false,
            ),
            AccountMeta::new_readonly(upgrade_authority, true),
            AccountMeta::new_readonly(mailbox, false),
        ],
    ))
}

/// Builds a callRemoteWithOverrides instruction. The owner may be a wallet or a PDA signing a CPI.
/// Accounts: config, owner, mailbox, then the seven normal Mailbox dispatch accounts.
/// `unique_message` must sign and be unused for dispatch, as for Hyp token transfers.
pub fn call_remote_with_overrides_instruction(
    program_id: Pubkey,
    mailbox: Pubkey,
    owner: Pubkey,
    payer: Pubkey,
    unique_message: Pubkey,
    call: CallRemoteWithOverrides,
) -> Result<SolanaInstruction, ProgramError> {
    dispatch_instruction(
        program_id,
        mailbox,
        owner,
        payer,
        unique_message,
        Instruction::CallRemoteWithOverrides(call),
    )
}

/// Builds `callRemote` using enrolled defaults and the same accounts/signers as overrides.
pub fn call_remote_instruction(
    program_id: Pubkey,
    mailbox: Pubkey,
    owner: Pubkey,
    payer: Pubkey,
    unique_message: Pubkey,
    call: CallRemote,
) -> Result<SolanaInstruction, ProgramError> {
    dispatch_instruction(
        program_id,
        mailbox,
        owner,
        payer,
        unique_message,
        Instruction::CallRemote(call),
    )
}

fn dispatch_instruction(
    program_id: Pubkey,
    mailbox: Pubkey,
    owner: Pubkey,
    payer: Pubkey,
    unique_message: Pubkey,
    instruction: Instruction,
) -> Result<SolanaInstruction, ProgramError> {
    Ok(SolanaInstruction::new_with_bytes(
        program_id,
        &borsh::to_vec(&instruction)?,
        vec![
            AccountMeta::new_readonly(config_address(&program_id).0, false),
            AccountMeta::new_readonly(owner, true),
            AccountMeta::new_readonly(mailbox, false),
            AccountMeta::new(
                Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), &mailbox).0,
                false,
            ),
            AccountMeta::new_readonly(
                Pubkey::find_program_address(
                    mailbox_message_dispatch_authority_pda_seeds!(),
                    &program_id,
                )
                .0,
                false,
            ),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(unique_message, true),
            AccountMeta::new(
                Pubkey::find_program_address(
                    mailbox_dispatched_message_pda_seeds!(&unique_message),
                    &mailbox,
                )
                .0,
                false,
            ),
        ],
    ))
}
