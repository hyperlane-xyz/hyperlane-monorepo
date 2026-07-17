//! Interface to Circle's real, deployed CCTP v2 `MessageTransmitterV2`
//! Solana program (`send_message` instruction only — this program never
//! calls `receive_message`; that's `hyperlane-sealevel-cctp-receiver`'s job).
//!
//! Source (confirmed byte-for-byte via `circlefin/solana-cctp-contracts`,
//! `programs/v2/message-transmitter-v2/src/instructions/send_message.rs`,
//! branch `master`):
//! - Accounts (`SendMessageContext`): `event_rent_payer` (signer, mut),
//!   `sender_authority_pda` (signer, PDA `[b"sender_authority"]` under the
//!   *calling* program's ID), `message_transmitter` (mut, Circle's config PDA,
//!   seeds `[b"message_transmitter"]` under Circle's program ID),
//!   `message_sent_event_data` (a **fresh account created per call** — not a
//!   PDA; the caller must supply an uninitialized keypair-backed account),
//!   `sender_program` (this program's own executable account — its key
//!   becomes the CCTP message's `sender` field), `system_program`.
//! - Params (`SendMessageParams`): `destination_domain: u32`,
//!   `recipient: Pubkey`, `destination_caller: Pubkey`,
//!   `min_finality_threshold: u32`, `message_body: Vec<u8>`.
//! - Instruction discriminator: Anchor sighash `sha256("global:send_message")[..8]`.
//!
//! CAVEAT: this was researched via GitHub source reads, not verified against
//! a live devnet transaction. Before mainnet use, confirm the discriminator,
//! PDA seeds, and account ordering against an actual `send_message` call on
//! devnet (Circle's program ID is identical on mainnet-beta and devnet).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

solana_program::declare_id!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");

/// `sha256("global:send_message")[..8]` — Anchor's instruction sighash
/// convention. Precomputed rather than hashed on-chain since it's a fixed
/// constant of Circle's program interface.
pub const SEND_MESSAGE_DISCRIMINATOR: [u8; 8] = [0x39, 0x28, 0x22, 0xb2, 0xbd, 0x0a, 0x41, 0x1a];

/// Circle's `MessageTransmitter` config PDA seed (under Circle's own program ID).
pub const MESSAGE_TRANSMITTER_SEED: &[u8] = b"message_transmitter";

/// Derives Circle's `MessageTransmitter` config PDA.
pub fn derive_message_transmitter_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MESSAGE_TRANSMITTER_SEED], &ID)
}

/// Instruction args for Circle's `send_message`, Borsh-encoded after the
/// 8-byte Anchor discriminator (Anchor instruction args are plain Borsh).
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
pub struct SendMessageParams {
    pub destination_domain: u32,
    pub recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub min_finality_threshold: u32,
    pub message_body: Vec<u8>,
}

/// Builds the CPI instruction for Circle's `send_message`.
///
/// Accounts, in Circle's required order:
/// 0. `[signer, writable]` event_rent_payer
/// 1. `[signer]` sender_authority_pda (this program's own PDA)
/// 2. `[writable]` message_transmitter (Circle's config PDA)
/// 3. `[signer, writable]` message_sent_event_data (fresh account)
/// 4. `[]` sender_program (this program's own executable account)
/// 5. `[]` system_program
#[allow(clippy::too_many_arguments)]
pub fn send_message_instruction(
    event_rent_payer: Pubkey,
    sender_authority_pda: Pubkey,
    message_sent_event_data: Pubkey,
    sender_program: Pubkey,
    system_program: Pubkey,
    destination_domain: u32,
    recipient: Pubkey,
    destination_caller: Pubkey,
    min_finality_threshold: u32,
    message_body: Vec<u8>,
) -> Result<SolanaInstruction, ProgramError> {
    let (message_transmitter, _) = derive_message_transmitter_pda();

    let params = SendMessageParams {
        destination_domain,
        recipient,
        destination_caller,
        min_finality_threshold,
        message_body,
    };
    let mut data = SEND_MESSAGE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&borsh::to_vec(&params).map_err(|_| ProgramError::BorshIoError)?);

    Ok(SolanaInstruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(event_rent_payer, true),
            AccountMeta::new_readonly(sender_authority_pda, true),
            AccountMeta::new(message_transmitter, false),
            AccountMeta::new(message_sent_event_data, true),
            AccountMeta::new_readonly(sender_program, false),
            AccountMeta::new_readonly(system_program, false),
        ],
        data,
    })
}

#[cfg(test)]
mod test {
    use super::*;

    /// Catches transcription drift in the hardcoded discriminator constant —
    /// independently recomputes Anchor's `sha256("global:send_message")[..8]`
    /// sighash convention via `solana_program::hash` (off-chain SHA256, no
    /// syscall needed for this host-side test).
    #[test]
    fn test_send_message_discriminator_matches_anchor_sighash() {
        let computed = solana_program::hash::hash(b"global:send_message");
        assert_eq!(&computed.to_bytes()[..8], &SEND_MESSAGE_DISCRIMINATOR[..]);
    }

    #[test]
    fn test_send_message_instruction_builds() {
        let ixn = send_message_instruction(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            5,
            Pubkey::new_unique(),
            Pubkey::new_from_array([0u8; 32]),
            2000,
            vec![0xCC; 32],
        )
        .unwrap();
        assert_eq!(ixn.program_id, ID);
        assert_eq!(ixn.accounts.len(), 6);
        assert_eq!(&ixn.data[..8], &SEND_MESSAGE_DISCRIMINATOR[..]);
        let params = SendMessageParams::try_from_slice(&ixn.data[8..]).unwrap();
        assert_eq!(params.destination_domain, 5);
        assert_eq!(params.min_finality_threshold, 2000);
        assert_eq!(params.message_body, vec![0xCC; 32]);
    }
}
