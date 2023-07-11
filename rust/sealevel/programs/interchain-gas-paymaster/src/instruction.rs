use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    InitRelayer(InitRelayer),
}
