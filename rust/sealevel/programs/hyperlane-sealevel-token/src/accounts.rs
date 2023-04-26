//! TODO

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_mailbox::accounts::AccountData;
use solana_program::pubkey::Pubkey;

pub type HyperlaneTokenAccount = AccountData<HyperlaneToken>;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct HyperlaneToken {
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The mailbox's local domain.
    pub mailbox_local_domain: u32,
    /// The bump seed for this PDA.
    pub bump: u8,
    /// The bump seed for the native token collateral PDA.
    pub native_collateral_bump: u8,
    /// The name of the token.
    pub native_name: String,
    /// The symbol of the token.
    pub native_symbol: String, // FIXME use datatype to enforce character set
}

impl Default for HyperlaneToken {
    fn default() -> Self {
        Self {
            mailbox: Pubkey::new_from_array([0; 32]),
            mailbox_local_domain: 0,
            bump: 0,
            native_collateral_bump: 0,
            native_name: Default::default(),
            native_symbol: Default::default(),
        }
    }
}

pub type HyperlaneErc20Account = AccountData<HyperlaneErc20>;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct HyperlaneErc20 {
    /// The bump seed for this PDA.
    pub erc20_bump: u8,
    /// The bump seed for the SPL token mint PDA.
    pub mint_bump: u8,
    /// The supply of the token. This acts as a cap on the number of tokens that can be minted in
    /// addition to the implicit cap of `u64::MAX`.
    pub total_supply: u64,
    /// The name of the token.
    pub name: String,
    /// The symbol of the token.
    pub symbol: String, // FIXME use datatype to enforce character set
}

impl Default for HyperlaneErc20 {
    fn default() -> Self {
        Self {
            // mailbox_outbox: Pubkey::new_from_array([0; 32]),
            erc20_bump: 0,
            mint_bump: 0,
            total_supply: 0,
            name: Default::default(),
            symbol: Default::default(),
        }
    }
}
