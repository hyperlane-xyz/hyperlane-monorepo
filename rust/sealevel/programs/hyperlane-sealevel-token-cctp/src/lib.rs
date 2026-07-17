//! Hyperlane Sealevel token program bridging native USDC via Circle's CCTP
//! v2, mirroring the EVM `TokenBridgeCctpV2` design (see
//! `solidity/contracts/token/TokenBridgeCctpV2.sol` and `CCTP.md`).
//!
//! Reuses `hyperlane-sealevel-token-lib`'s generic Router/Plugin framework
//! for the send side (`transfer_in` CPIs into Circle's real
//! `TokenMessengerMinterV2.deposit_for_burn`). The receive side is *not*
//! done via the plugin's `transfer_out` — that trait method only receives a
//! plain `amount`, with no way to pass the raw `(burn_message, attestation)`
//! bytes Circle's attestation requires. Instead, this program implements
//! its own `InterchainSecurityModuleInstruction` (mirroring
//! `TokenBridgeCctpV2` fusing Router + ISM on EVM): `Verify()` receives
//! `(burn_message, attestation)` as `metadata` (the standard ISM interface
//! already supports this), parses the `BurnMessage`, cross-validates it
//! against the accompanying Hyperlane `TokenMessage`, then CPIs into
//! Circle's real `MessageTransmitterV2.receive_message` with
//! `receiver = TokenMessengerMinterV2` — Circle's own program, not this one,
//! so this never hits the A->B->A reentrancy restriction that shaped the
//! composite-ism `CctpV2` GMP node's design. The mint happens as a side
//! effect of `Verify()` succeeding, exactly as on EVM; `transfer_out` (called
//! afterward, same atomic Mailbox instruction) is a no-op.

#![allow(unexpected_cfgs)]

pub mod accounts;
pub mod circle;
pub mod instruction;
pub mod ism;
pub mod plugin;
pub mod processor;
