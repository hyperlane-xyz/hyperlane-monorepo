//! Receiver for Circle's real CCTP v2 `MessageTransmitterV2` callback.
//!
//! Exists because a composite-ism `CctpV2` node cannot itself CPI into
//! Circle's program: Circle's `receive_message` verifies the attestation
//! then CPIs back into whichever program is registered as `receiver`, and if
//! that were the ISM itself, the call shape would be
//! ISM -> MessageTransmitterV2 -> ISM — indirect reentrancy, which the
//! Solana runtime rejects outright with `ReentrancyNotAllowed` (confirmed
//! against solana.com/docs/core/cpi: "Direct self-recursion is allowed
//! (A->A->A). Indirect reentrancy is not (A->B->A returns
//! ReentrancyNotAllowed).").
//!
//! So this program stands in as the `receiver` instead: Circle CPIs into
//! *this*, authenticated via the `authority_pda` signer Circle derives under
//! its own program ID (see `circle.rs`), and this program records a
//! `VerifiedMessage` marker PDA. A composite-ism `CctpV2` node then reads
//! that PDA directly — no crypto duplicated anywhere in Hyperlane's code,
//! Circle's real program does 100% of the attestation verification.
//!
//! Expected usage: the relayer submits ONE Solana transaction with two
//! top-level instructions — (1) call Circle's real
//! `MessageTransmitterV2.receive_message` directly, with this program as
//! `receiver` and this program's `VerifiedMessage` PDA + payer + system
//! program appended as `remaining_accounts`; (2) `Mailbox.process()` ->
//! composite-ism `Verify()`, which reads the PDA written by instruction 1
//! (already visible within the same atomic transaction).

pub mod accounts;
pub mod circle;
pub mod error;
pub mod processor;

pub use processor::process_instruction;
