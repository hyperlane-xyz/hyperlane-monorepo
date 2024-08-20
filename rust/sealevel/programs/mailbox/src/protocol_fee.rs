//! Data structures for the protocol fee configuration.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// The Protocol Fee configuration.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Eq, Clone, Default)]
pub struct ProtocolFee {
    /// The current protocol fee, expressed in the lowest denomination.
    pub fee: u64,
    /// The beneficiary of protocol fees.
    pub beneficiary: Pubkey,
}
