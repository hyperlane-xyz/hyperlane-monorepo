use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;

use solana_program::pubkey::Pubkey;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    InitRelayer(InitRelayer),
    PayForGas(PayForGas),
    QuoteGasPayment(QuoteGasPayment),
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitRelayer {
    pub owner: Option<Pubkey>,
    pub beneficiary: Pubkey,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct PayForGas {
    pub relayer: Pubkey,
    pub message_id: H256,
    pub destination_domain: u32,
    // TODO maybe U256? check Fuel impl...
    pub gas_amount: u64,
    pub refund_recipient: Pubkey,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct QuoteGasPayment {
    pub relayer: Pubkey,
    pub destination_domain: u32,
    // TODO maybe U256?
    pub gas_amount: u64,
}
