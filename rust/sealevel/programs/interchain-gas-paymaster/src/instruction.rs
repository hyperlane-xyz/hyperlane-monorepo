use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    InitRelayer(InitRelayer),
}

pub struct InitRelayer {
    pub owner: Option<Pubkey>,
    pub beneficiary: Pubkey,
}
