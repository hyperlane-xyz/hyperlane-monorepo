//! Universal Router — Solana/SVM (native Rust)
//!
//! Command-based swap and bridge router. Architecturally mirrors the Anchor
//! `universal-router-sealevel` project but uses native Hyperlane sealevel
//! infrastructure types (no Anchor dependency).
//!
//! Entry points (via `RouterInstruction` enum):
//!   Execute                — execute a batch of commands
//!   ExecuteWithDeadline    — execute with Unix timestamp deadline check
//!   Reveal                 — directly execute a committed cross-chain swap
//!   ClosePendingSwap       — reclaim a stale PDA (called by original recipient)
//!
//! Hyperlane mailbox entry points (via `MessageRecipientInstruction` discriminators):
//!   Handle (body == 96 B)  — store commitment + create PendingSwap PDA
//!   Handle (body >= 64 B)  — verify commitment and execute the queued swap
//!   HandleAccountMetas     — return accounts the relayer must include
//!   InterchainSecurityModule / AccountMetas — ISM interface (returns None)

pub mod constants;
pub mod dispatcher;
pub mod error;
pub mod hyperlane;
pub mod instruction;
pub mod modules;
pub mod processor;
pub mod types;

// Program ID — matches the deployed keypair from universal-router-sealevel.
// Update with `solana-program deploy` output before mainnet deployment.
// See README.md § "Update the program ID".
solana_program::declare_id!("2CttnaLkYbNHbaFDFnQ8PMCnzUwTGrKnskBxPM4TRWGp");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction<'info>(
    program_id: &solana_program::pubkey::Pubkey,
    accounts: &'info [solana_program::account_info::AccountInfo<'info>],
    instruction_data: &[u8],
) -> solana_program::entrypoint::ProgramResult {
    processor::process(program_id, accounts, instruction_data)
}
