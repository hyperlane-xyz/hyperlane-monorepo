//! Interchain gas paymaster accounts.

use std::collections::HashMap;

use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{clock::Slot, pubkey::Pubkey};

use hyperlane_core::{H256, U256};

use crate::error::Error;

pub const TOKEN_EXCHANGE_RATE_SCALE: u64 = 10u64.pow(19);
pub const SOL_DECIMALS: u8 = 9;

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

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct ProgramData {
    pub payment_count: u64,
}

impl SizedData for ProgramData {
    fn size(&self) -> usize {
        // 8 for payment_count
        8
    }
}

pub type ProgramDataAccount = AccountData<ProgramData>;

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct OverheadIgp {
    pub owner: Option<Pubkey>,
    pub inner: Pubkey,
    pub gas_overheads: HashMap<u32, u64>,
}

impl OverheadIgp {
    pub fn gas_overhead(&self, destination_domain: u32) -> u64 {
        self.gas_overheads
            .get(&destination_domain)
            .copied()
            .unwrap_or(0)
    }
}

pub type OverheadIgpAccount = AccountData<OverheadIgp>;

pub type IgpAccount = AccountData<IgpData>;

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct IgpData {
    pub salt: H256,
    pub owner: Option<Pubkey>,
    pub beneficiary: Pubkey,
    pub gas_oracle: HashMap<u32, GasOracle>,
}

impl SizedData for IgpData {
    fn size(&self) -> usize {
        // 33 for owner (1 byte Option, 32 bytes for pubkey)
        // 8 for payment_count
        // 32 for beneficiary
        // 4 for gas_overheads.len()
        // N * (4 + 8) for gas_overhead contents
        // 4 for gas_oracle.len()
        // M * (4 + 8) for gas_oracle contents
        33 + 8 + 32 + 4 + (self.gas_oracle.len() * (4 + 8))
    }
}

impl IgpData {
    pub fn quote_gas_payment(
        &self,
        destination_domain: u32,
        gas_amount: u64,
    ) -> Result<u64, Error> {
        let oracle = self
            .gas_oracle
            .get(&destination_domain)
            .ok_or(Error::NoGasOracleSetForDestinationDomain)?;
        let RemoteGasData {
            token_exchange_rate,
            gas_price,
            token_decimals,
        } = match oracle {
            GasOracle::RemoteGasData(data) => data,
        };

        // Arithmetic is done using U256 to avoid overflows.

        // The total cost quoted in the destination chain's native token.
        let destination_gas_cost = U256::from(gas_amount) * U256::from(*gas_price);

        // Convert to the local native token (decimals not yet accounted for).
        let origin_cost = (destination_gas_cost * U256::from(*token_exchange_rate))
            / U256::from(TOKEN_EXCHANGE_RATE_SCALE);

        // Convert from the remote token's decimals to the local token's decimals.
        let origin_cost = convert_decimals(origin_cost, *token_decimals, SOL_DECIMALS);

        // Panics if an overflow occurs.
        Ok(origin_cost.as_u64())
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct RemoteGasData {
    pub token_exchange_rate: u128,
    pub gas_price: u128,
    pub token_decimals: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct GasPayment {
    pub igp: Pubkey,
    pub sequence_number: u64,
    pub destination_domain: u32,
    pub message_id: H256,
    // TODO maybe U256? check Fuel impl...
    pub gas_amount: u64,
    pub slot: Slot,
}

impl SizedData for GasPayment {
    fn size(&self) -> usize {
        // 32 for igp
        // 8 for sequence_number
        // 4 for destination_domain
        // 32 for message_id
        // 8 for gas_amount
        // 8 for slot
        32 + 8 + 4 + 32 + 8 + 8
    }
}

pub type GasPaymentAccount = AccountData<GasPayment>;

fn convert_decimals(num: U256, from_decimals: u8, to_decimals: u8) -> U256 {
    if from_decimals > to_decimals {
        num / U256::from(10u64).pow(U256::from(from_decimals - to_decimals))
    } else if from_decimals < to_decimals {
        num * U256::from(10u64).pow(U256::from(to_decimals - from_decimals))
    } else {
        num
    }
}
