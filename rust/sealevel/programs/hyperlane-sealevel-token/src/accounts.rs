//! TODO

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_mailbox::accounts::AccountData;
use solana_program::pubkey::Pubkey;

pub type HyperlaneTokenAccount = AccountData<HyperlaneToken>;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct HyperlaneToken {
    /// The bump seed for this PDA.
    pub bump: u8,
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The mailbox's local domain.
    pub mailbox_local_domain: u32,
    /// The mint & mint authority
    pub mint: Pubkey,
    /// The bump seed for the SPL token mint PDA.
    pub mint_bump: u8,
}

impl Default for HyperlaneToken {
    fn default() -> Self {
        Self {
            bump: 0,
            mailbox: Pubkey::new_from_array([0; 32]),
            mailbox_local_domain: 0,
            
            mint: Pubkey::new_from_array([0; 32]),
            mint_bump: 0,
            // native_collateral_bump: 0,
            // native_name: Default::default(),
            // native_symbol: Default::default(),
        }
    }
}

// pub type MintAuthorityAccount = AccountData<MintAuthority>;

// #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
// pub struct MintAuthority {
//     /// The bump seed for the SPL token mint PDA.
//     pub bump: u8,
// }
