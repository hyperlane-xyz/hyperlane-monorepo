use borsh::{BorshDeserialize, BorshSerialize};

use hyperlane_sealevel_mailbox::accounts::AccountData;
use solana_program::pubkey::Pubkey;

use crate::instruction::ValidatorsAndThreshold;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct DomainData {
    pub bump_seed: u8,
    pub validators_and_threshold: ValidatorsAndThreshold,
}

pub type DomainDataAccount = AccountData<DomainData>;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct AuthorityData {
    pub bump_seed: u8,
    pub owner_authority: Pubkey,
}

impl AuthorityData {
    pub const SIZE: usize = 1 + 32;
}

pub type AuthorityAccount = AccountData<AuthorityData>;
