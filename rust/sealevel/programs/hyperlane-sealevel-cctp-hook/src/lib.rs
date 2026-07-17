//! Solana Hyperlane hook that forwards a dispatched message's ID to Circle's
//! real CCTP v2 `MessageTransmitterV2` program, so Iris attests it and a
//! destination composite-ism `CctpV2` node (via `hyperlane-sealevel-cctp-receiver`)
//! can verify it.
//!
//! This direction is a plain one-way CPI with no callback, so none of the
//! self-reentrancy constraints that shape the receive side apply here.
//!
//! Sealevel has no Mailbox-driven "post_dispatch hook" trait (the Mailbox's
//! `OutboxDispatch` instruction has no hook hook-up, and the existing
//! `hyperlane-sealevel-igp` program is itself just an explicitly-invoked
//! instruction — apps call `PayForGas` themselves rather than the Mailbox
//! calling into it). This program follows the same pattern: whatever
//! dispatches a Hyperlane message on Solana calls `SendMessageId` itself (in
//! the same transaction as the dispatch), rather than the Mailbox invoking
//! it automatically.

pub mod accounts;
pub mod circle;
pub mod error;
pub mod instruction;
pub mod pda_seeds;
pub mod processor;

pub use processor::process_instruction;
