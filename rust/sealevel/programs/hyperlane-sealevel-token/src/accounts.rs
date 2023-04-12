//! TODO

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_mailbox::accounts::AccountData;
use solana_program::pubkey::Pubkey;

pub type HyperlaneErc20Account = AccountData<HyperlaneErc20>;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct HyperlaneErc20 {
    /// The bump seed for this PDA.
    pub erc20_bump: u8,
    /// The bump seed SPL token mint PDA.
    pub mint_bump: u8,

    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The address of the mailbox outbox account.
    pub mailbox_outbox: Pubkey,
    /// The mailbox's local domain.
    pub mailbox_local_domain: u32,
    /// The address of the interchain gas paymaster contract.
    pub interchain_gas_paymaster: Pubkey,

    /// The supply of the token. This acts as a cap on the number of tokens that can be minted in
    /// addition to the implicit cap of `u64::MAX`.
    pub total_supply: u64,
    /// The name of the token.
    pub name: String,
    /// The symbol of the token.
    pub symbol: String, // FIXME use datatype to enforce character set?
}

impl Default for HyperlaneErc20 {
    // FIXME should probably define another trait rather than use Default for this...
    fn default() -> Self {
        Self {
            erc20_bump: 0,
            mint_bump: 0,
            mailbox: Pubkey::new_from_array([0; 32]),
            mailbox_outbox: Pubkey::new_from_array([0; 32]),
            mailbox_local_domain: 0,
            interchain_gas_paymaster: Pubkey::new_from_array([0; 32]),
            total_supply: 0,
            name: Default::default(),
            symbol: Default::default(),
        }
    }
}
