//! Accounts for the Hyperlane token program.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_mailbox::accounts::AccountData;
use solana_program::pubkey::Pubkey;
use std::fmt::Debug;

pub type HyperlaneTokenAccount<T> = AccountData<HyperlaneToken<T>>;

/// A PDA account containing the data for a Hyperlane token
/// and any plugin-specific data.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct HyperlaneToken<T> {
    /// The bump seed for this PDA.
    pub bump: u8,
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The mailbox's local domain.
    pub mailbox_local_domain: u32,
    /// Plugin-specific data.
    pub plugin_data: T,
}
