//! Accounts for the Hyperlane token program.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_mailbox::accounts::AccountData;
use solana_program::pubkey::Pubkey;

pub type HyperlaneTokenAccount = AccountData<HyperlaneToken>;

/// A PDA account containing the data for a Hyperlane token.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct HyperlaneToken {
    /// The bump seed for this PDA.
    pub bump: u8,
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The mailbox's local domain.
    pub mailbox_local_domain: u32,
    /// The mint & mint authority.
    pub mint: Pubkey,
    /// The bump seed for the mint / mint authority PDA.
    pub mint_bump: u8,
}
