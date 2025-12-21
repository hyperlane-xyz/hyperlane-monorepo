//! Constants for Kaspa Hyperlane integration.
//!
//! Includes domain IDs and protocol constants.

use hyperlane_core::H256;

// ============================================================================
// Domain IDs for Hyperlane protocol routing
// ============================================================================

pub const ALLOWED_HL_MESSAGE_VERSION: u8 = 3;

pub const HL_DOMAIN_DYM_MAINNET: u32 = 1570310961; // NOTE: was patched to this value just before mainnet release. The old value did not do modulo on derivation.
pub const HL_DOMAIN_DYM_LOCAL: u32 = 587907060;
pub const HL_DOMAIN_DYM_TESTNET_BLUMBUS: u32 = 482195613;
pub const HL_DOMAIN_DYM_PLAYGROUND_202507: u32 = 180353102;
pub const HL_DOMAIN_DYM_PLAYGROUND_202507_LEGACY: u32 = 1260813472;
pub const HL_DOMAIN_DYM_PLAYGROUND_202509: u32 = 1260813473;
pub const HL_DOMAIN_KASPA_MAINNET: u32 = 1082673309;
pub const HL_DOMAIN_KASPA_TEST10: u32 = 897658017;
pub const HL_DOMAIN_KASPA_TEST10_LEGACY: u32 = 80808082; // deprecated

// ============================================================================
// Kaspa contract addresses (placeholder values)
// ============================================================================

// These are arbitrary, but MUST be unique and consistent.
// A good practice is to use a hash of a descriptive string.
// e.g., keccak256("kaspa_mailbox")

#[allow(dead_code)]
pub const KASPA_MAILBOX_ADDRESS: H256 = H256([
    0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0,
]);

#[allow(dead_code)]
pub const KASPA_VALIDATOR_ANNOUNCE_ADDRESS: H256 = H256([
    0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0,
]);

#[allow(dead_code)]
pub const KASPA_IGP_ADDRESS: H256 = H256([
    0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0,
]);

#[allow(dead_code)]
pub const KASPA_ISM_ADDRESS: H256 = H256([
    0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0,
]);
