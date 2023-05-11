use borsh::{BorshDeserialize, BorshSerialize};

use hyperlane_sealevel_mailbox::accounts::AccountData;

use crate::instruction::ValidatorsAndThreshold;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct DomainData {
    pub bump_seed: u8,
    pub validators_and_threshold: ValidatorsAndThreshold,
}

pub type DomainDataAccount = AccountData<DomainData>;
