use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;

use solana_program::pubkey::Pubkey;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    Init,
    InitIgp(InitIgp),
    InitOverheadIgp(InitOverheadIgp),
    PayForGas(PayForGas),
    QuoteGasPayment(QuoteGasPayment),
    TransferOwnership(Option<Pubkey>),
    SetIgpBeneficiary(Pubkey),
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitIgp {
    pub salt: H256,
    pub owner: Option<Pubkey>,
    pub beneficiary: Pubkey,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitOverheadIgp {
    pub salt: H256,
    pub owner: Option<Pubkey>,
    pub inner: Pubkey,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct PayForGas {
    // TODO needed? could imply from accounts
    // pub igp: Pubkey,
    pub message_id: H256,
    pub destination_domain: u32,
    // TODO maybe U256? check Fuel impl...
    pub gas_amount: u64,
    pub refund_recipient: Pubkey,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct QuoteGasPayment {
    // TODO needed? could imply from accounts
    // pub igp: Pubkey,
    pub destination_domain: u32,
    // TODO maybe U256?
    pub gas_amount: u64,
}
