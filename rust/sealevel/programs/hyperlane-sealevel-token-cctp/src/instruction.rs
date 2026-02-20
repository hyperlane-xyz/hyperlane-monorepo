//! Instructions for the CCTP token program.

use account_utils::{DiscriminatorData, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use std::collections::HashMap;

/// Instructions supported by the CCTP token program.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub enum CctpTokenInstruction {
    /// Add or update domain mappings.
    ///
    /// Accounts expected:
    /// 0. `[writable]` The token PDA account.
    /// 1. `[signer]` The owner.
    AddDomainMappings {
        /// Domain mappings to add (Hyperlane domain -> Circle domain)
        mappings: HashMap<u32, u32>,
    },
}

impl DiscriminatorData for CctpTokenInstruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}
