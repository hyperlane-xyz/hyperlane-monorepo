//! Off-chain interface for the Hyperlane Sealevel programs: instruction enums and
//! builders, account layouts, PDA seeds, discriminators and error codes.
//!
//! The types are copied from the program crates under `rust/sealevel/programs` (and the
//! data types of `hyperlane-sealevel-token-lib` / `hyperlane-sealevel-connection-client`),
//! with on-chain-only logic left out, so off-chain code doesn't depend on the programs.
//! Byte compatibility is pinned by the golden vectors in `testdata/golden`, which are
//! generated from the program crates.
//!
//! Each module mirrors one program crate. PDA seed macros are exported at the crate root
//! and re-exported from their program's module.

#![deny(unsafe_code)]

pub mod composite_ism;
pub mod connection_client;
pub mod helloworld;
pub mod igp;
pub mod mailbox;
pub mod multisig_ism_message_id;
pub mod token;
pub mod token_collateral;
pub mod token_native;
pub mod token_synthetic;
pub mod validator_announce;
