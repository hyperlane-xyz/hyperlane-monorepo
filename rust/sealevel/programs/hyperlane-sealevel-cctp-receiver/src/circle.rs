//! Interface to Circle's real, deployed CCTP v2 `MessageTransmitterV2`
//! Solana program — the callback side only (this program is a `receiver`;
//! it never itself calls `receive_message` or `send_message`).
//!
//! Confirmed byte-for-byte from `circlefin/solana-cctp-contracts`,
//! `programs/v2/message-transmitter-v2/src/instructions/receive_message.rs`,
//! branch `master` (fetched raw, not paraphrased):
//! - `HandleReceiveMessageParams` field order: `remote_domain: u32`,
//!   `sender: Pubkey`, `finality_threshold_executed: u32`,
//!   `message_body: Vec<u8>`, `authority_bump: u8` — same struct used for
//!   both the finalized and unfinalized callback variants.
//! - Only `authority_pda` (readonly, signer) plus the original caller's
//!   `remaining_accounts` (in the order the caller supplied them) are
//!   forwarded into the callback CPI. `message_transmitter` and Circle's own
//!   `event_authority`/`emit_cpi!` event are NOT forwarded.
//! - The CCTP `nonce` is NOT included anywhere in the callback data — only
//!   used locally by Circle's own program for its `used_nonce` PDA and
//!   `MessageReceived` event.
//! - Discriminator seed strings: `"global:handle_receive_finalized_message"`
//!   and `"global:handle_receive_unfinalized_message"` (Anchor sighash:
//!   `sha256(seed)[..8]`, prepended to `params.try_to_vec()`).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

solana_program::declare_id!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");

/// `sha256("global:handle_receive_finalized_message")[..8]`.
pub const HANDLE_RECEIVE_FINALIZED_DISCRIMINATOR: [u8; 8] =
    [0xba, 0xfc, 0xef, 0x46, 0x56, 0xb4, 0x6e, 0x5f];

/// `sha256("global:handle_receive_unfinalized_message")[..8]`.
pub const HANDLE_RECEIVE_UNFINALIZED_DISCRIMINATOR: [u8; 8] =
    [0xc8, 0xa9, 0xaf, 0x14, 0xc8, 0x3a, 0xb6, 0x3d];

/// Seed for Circle's per-receiver authority PDA, derived under Circle's own
/// `MessageTransmitterV2` program ID (`seeds::program` in their Anchor
/// context). Only Circle's real program can `invoke_signed` for this PDA —
/// that's the entire authentication mechanism for the callback: no other
/// program, however it's written, can produce a valid signature for it.
pub const MESSAGE_TRANSMITTER_AUTHORITY_SEED: &[u8] = b"message_transmitter_authority";

/// Derives the authority PDA Circle signs the callback with, for a given
/// receiver program.
pub fn derive_message_transmitter_authority_pda(receiver_program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            MESSAGE_TRANSMITTER_AUTHORITY_SEED,
            receiver_program_id.as_ref(),
        ],
        &ID,
    )
}

/// Instruction args Circle serializes (after its 8-byte discriminator) for
/// both `handle_receive_finalized_message` and
/// `handle_receive_unfinalized_message`. Field order matches Circle's real
/// struct exactly — Borsh is order-sensitive, so this must not be reordered.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
pub struct HandleReceiveMessageParams {
    pub remote_domain: u32,
    pub sender: Pubkey,
    pub finality_threshold_executed: u32,
    pub message_body: Vec<u8>,
    pub authority_bump: u8,
}

#[cfg(test)]
mod test {
    use super::*;

    /// Catches transcription drift in the hardcoded discriminator constants.
    #[test]
    fn test_discriminators_match_anchor_sighash() {
        let finalized = solana_program::hash::hash(b"global:handle_receive_finalized_message");
        assert_eq!(
            &finalized.to_bytes()[..8],
            &HANDLE_RECEIVE_FINALIZED_DISCRIMINATOR[..]
        );

        let unfinalized = solana_program::hash::hash(b"global:handle_receive_unfinalized_message");
        assert_eq!(
            &unfinalized.to_bytes()[..8],
            &HANDLE_RECEIVE_UNFINALIZED_DISCRIMINATOR[..]
        );
    }

    #[test]
    fn test_handle_receive_message_params_roundtrip() {
        let params = HandleReceiveMessageParams {
            remote_domain: 0,
            sender: Pubkey::new_unique(),
            finality_threshold_executed: 2000,
            message_body: vec![0xCC; 32],
            authority_bump: 255,
        };
        let encoded = borsh::to_vec(&params).unwrap();
        let decoded = HandleReceiveMessageParams::try_from_slice(&encoded).unwrap();
        assert_eq!(params, decoded);
    }
}
