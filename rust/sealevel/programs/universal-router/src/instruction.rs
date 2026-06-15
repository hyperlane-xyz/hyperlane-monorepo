//! Router instruction enum for non-Hyperlane entry points.
//!
//! Encoded as a Borsh enum (1-byte variant index + fields). The processor
//! first tries `MessageRecipientInstruction::decode()` for Hyperlane mailbox
//! calls, then falls through to this enum.
//!
//! Account layouts per instruction:
//!
//! Execute / ExecuteWithDeadline:
//!   [0] authority          signer
//!   [1] system_program
//!   [2..] remaining_accounts for commands (consumed by dispatcher)
//!
//! Reveal (direct — not via Hyperlane mailbox):
//!   [0] payer              writable signer
//!   [1] pending_swap PDA   writable (closed on success, rent → fee_payer_pda)
//!   [2] pda_token_ata      writable (input tokens owned by pending_swap PDA)
//!   [3] fee_payer_pda      writable (receives pending_swap rent on close)
//!   [4] system_program
//!   [5..] swap command accounts
//!
//! ClosePendingSwap:
//!   [0] pending_swap PDA   writable (closed; rent → recipient)
//!   [1] recipient          writable signer (must match PendingSwap.recipient)
//!   [2] system_program

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::program_error::ProgramError;

#[derive(BorshSerialize, BorshDeserialize)]
pub enum RouterInstruction {
    /// Execute a batch of commands with no deadline.
    Execute(ExecuteIxn),
    /// Execute a batch of commands; reverts if `deadline` (Unix seconds) has passed.
    ExecuteWithDeadline(ExecuteWithDeadlineIxn),
    /// Directly execute a committed cross-chain swap (without going through the mailbox).
    Reveal(RevealIxn),
    /// Close a stale PendingSwap PDA; only the stored recipient may call this.
    ClosePendingSwap(ClosePendingSwapIxn),
}

impl RouterInstruction {
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct ExecuteIxn {
    pub commands: Vec<u8>,
    pub inputs: Vec<Vec<u8>>,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct ExecuteWithDeadlineIxn {
    pub commands: Vec<u8>,
    pub inputs: Vec<Vec<u8>>,
    pub deadline: i64,
}

/// Direct reveal — mirrors the Anchor `reveal` instruction.
///
/// `origin` + `sender` + `salt` are used to re-derive the pending_swap PDA
/// seeds and verify the signer.  `message` carries the borsh-encoded
/// (Vec<u8>, Vec<Vec<u8>>) swap payload.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct RevealIxn {
    pub origin: u32,
    pub sender: [u8; 32],
    pub message: Vec<u8>,
    pub salt: [u8; 32],
}

/// Close a stale PendingSwap and return tokens + rent to `recipient`.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct ClosePendingSwapIxn {
    pub origin: u32,
    pub sender: [u8; 32],
    pub salt: [u8; 32],
}
