//! Program instructions.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{derive_program_data_pda, derive_remote_config_pda, derive_sender_authority_pda},
    circle,
};

/// The program instructions.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    Init(Init),
    /// Sets or updates the CCTP send config for a Hyperlane destination
    /// domain. Owner-gated.
    SetRemoteConfig(SetRemoteConfig),
    /// Forwards `message_id` to Circle's real `MessageTransmitterV2` so
    /// Iris attests it, for a Hyperlane message dispatched to
    /// `destination_domain`. Permissionless — same call shape as
    /// `hyperlane-sealevel-igp`'s `PayForGas`: whatever dispatched the
    /// Hyperlane message calls this itself (typically in the same
    /// transaction as the dispatch), rather than the Mailbox invoking it
    /// automatically (Sealevel has no such hook mechanism — see module docs).
    SendMessageId(SendMessageId),
}

impl Instruction {
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        borsh::to_vec(&self).map_err(|_| ProgramError::BorshIoError)
    }
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct Init {
    pub owner: Option<Pubkey>,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetRemoteConfig {
    pub destination_domain: u32,
    pub circle_domain: u32,
    pub recipient: [u8; 32],
    pub destination_caller: [u8; 32],
    pub min_finality_threshold: u32,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SendMessageId {
    pub destination_domain: u32,
    pub message_id: H256,
}

/// Builds an `Init` instruction.
///
/// Accounts:
/// 0. `[]` The system program.
/// 1. `[signer]` The payer.
/// 2. `[writable]` The program data PDA.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (program_data, _) = derive_program_data_pda(&program_id);
    let ixn = Instruction::Init(Init { owner });
    Ok(SolanaInstruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(payer, true),
            AccountMeta::new(program_data, false),
        ],
        data: ixn.into_instruction_data()?,
    })
}

/// Builds a `SetRemoteConfig` instruction.
///
/// Accounts:
/// 0. `[]` The system program.
/// 1. `[]` The program data PDA (for owner check).
/// 2. `[signer]` The owner.
/// 3. `[signer, writable]` The payer (funds the remote config PDA if new).
/// 4. `[writable]` The remote config PDA for `destination_domain`.
#[allow(clippy::too_many_arguments)]
pub fn set_remote_config_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    payer: Pubkey,
    destination_domain: u32,
    circle_domain: u32,
    recipient: [u8; 32],
    destination_caller: [u8; 32],
    min_finality_threshold: u32,
) -> Result<SolanaInstruction, ProgramError> {
    let (program_data, _) = derive_program_data_pda(&program_id);
    let (remote_config, _) = derive_remote_config_pda(&program_id, destination_domain);
    let ixn = Instruction::SetRemoteConfig(SetRemoteConfig {
        destination_domain,
        circle_domain,
        recipient,
        destination_caller,
        min_finality_threshold,
    });
    Ok(SolanaInstruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(program_data, false),
            AccountMeta::new_readonly(owner, true),
            AccountMeta::new(payer, true),
            AccountMeta::new(remote_config, false),
        ],
        data: ixn.into_instruction_data()?,
    })
}

/// Builds a `SendMessageId` instruction.
///
/// Accounts, in order:
/// 0. `[]` The remote config PDA for `destination_domain`.
/// 1. `[signer, writable]` The payer (Circle's `event_rent_payer`).
/// 2. `[]` This program's `sender_authority` PDA.
/// 3. `[]` This program's own executable account (Circle's `sender_program`).
/// 4. `[]` The system program.
/// 5. `[]` Circle's `MessageTransmitterV2` program.
/// 6. `[writable]` Circle's `message_transmitter` config PDA.
/// 7. `[signer, writable]` A **fresh, uninitialized** keypair account for
///    Circle's `message_sent_event_data` — the caller must generate a new
///    keypair for every call and sign for it (Circle's program `init`s it).
pub fn send_message_id_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    message_sent_event_data: Pubkey,
    destination_domain: u32,
    message_id: H256,
) -> Result<SolanaInstruction, ProgramError> {
    let (remote_config, _) = derive_remote_config_pda(&program_id, destination_domain);
    let (sender_authority, _) = derive_sender_authority_pda(&program_id);
    let (message_transmitter, _) = circle::derive_message_transmitter_pda();
    let ixn = Instruction::SendMessageId(SendMessageId {
        destination_domain,
        message_id,
    });
    Ok(SolanaInstruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(remote_config, false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(sender_authority, false),
            AccountMeta::new_readonly(program_id, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(circle::ID, false),
            AccountMeta::new(message_transmitter, false),
            AccountMeta::new(message_sent_event_data, true),
        ],
        data: ixn.into_instruction_data()?,
    })
}
