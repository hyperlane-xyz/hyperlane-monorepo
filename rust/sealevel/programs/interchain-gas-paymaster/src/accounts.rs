//! Interchain gas paymaster accounts.

use std::collections::HashMap;

use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
pub enum GasOracle {
    RemoteGasData(RemoteGasData),
    // Could imagine a Pyth type, or CPI type, etc...
}

impl Default for GasOracle {
    fn default() -> Self {
        GasOracle::RemoteGasData(RemoteGasData::default())
    }
}

pub type RelayerAccount = AccountData<RelayerData>;

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct RelayerData {
    // TODO: should this be a global count?...
    pub payment_count: u64,
    pub beneficiary: Pubkey,
    // TODO: u64? or U256. Forgot what we did in Fuel and why...
    pub gas_overheads: HashMap<u32, u64>,
    pub gas_oracle: HashMap<u32, GasOracle>,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct RemoteGasData {
    pub token_exchange_rate: u128,
    pub gas_price: u128,
    pub token_decimals: u8,
}


