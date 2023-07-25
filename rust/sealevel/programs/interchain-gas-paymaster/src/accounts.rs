//! Interchain gas paymaster accounts.

use std::collections::HashMap;

use access_control::AccessControl;
use account_utils::{AccountData, DiscriminatorData, DiscriminatorPrefixed, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{clock::Slot, program_error::ProgramError, pubkey::Pubkey};

use hyperlane_core::{H256, U256};

use crate::error::Error;

pub const TOKEN_EXCHANGE_RATE_SCALE: u64 = 10u64.pow(19);
pub const SOL_DECIMALS: u8 = 9;

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone)]
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
    pub bump_seed: u8,
    pub payment_count: u64,
}

impl SizedData for ProgramData {
    fn size(&self) -> usize {
        // 1 for bump_seed
        // 8 for payment_count
        1 + 8
    }
}

pub type ProgramDataAccount = AccountData<ProgramData>;

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct OverheadIgp {
    pub bump_seed: u8,
    pub salt: H256,
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

    #[allow(unused)]
    pub fn quote_gas_payment(
        &self,
        destination_domain: u32,
        gas_amount: u64,
        inner_igp: &Igp,
    ) -> Result<u64, Error> {
        let total_gas_amount = self.gas_overhead(destination_domain) + gas_amount;
        inner_igp.quote_gas_payment(destination_domain, total_gas_amount)
    }
}

impl AccessControl for OverheadIgp {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

pub type OverheadIgpAccount = AccountData<OverheadIgp>;

impl SizedData for OverheadIgp {
    fn size(&self) -> usize {
        // 1 for bump_seed
        // 32 for salt
        // 33 for owner (1 byte Option, 32 bytes for pubkey)
        // 32 for inner
        // 4 for gas_overheads.len()
        // N * (4 + 8) for gas_overhead contents
        1 + 32 + 33 + 32 + 4 + (self.gas_overheads.len() * (4 + 8))
    }
}

pub type IgpAccount = AccountData<Igp>;

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct Igp {
    pub bump_seed: u8,
    pub salt: H256,
    pub owner: Option<Pubkey>,
    pub beneficiary: Pubkey,
    pub gas_oracles: HashMap<u32, GasOracle>,
}

impl SizedData for Igp {
    fn size(&self) -> usize {
        // 1 for bump_seed
        // 32 for salt
        // 33 for owner (1 byte Option, 32 bytes for pubkey)
        // 32 for beneficiary
        // 4 for gas_oracles.len()
        // M * (4 + (1 + 257)) for gas_oracles contents
        1 + 32 + 33 + 32 + 4 + (self.gas_oracles.len() * (1 + 257))
    }
}

impl Igp {
    pub fn quote_gas_payment(
        &self,
        destination_domain: u32,
        gas_amount: u64,
    ) -> Result<u64, Error> {
        let oracle = self
            .gas_oracles
            .get(&destination_domain)
            .ok_or(Error::NoGasOracleSetForDestinationDomain)?;
        let GasOracle::RemoteGasData(RemoteGasData {
            token_exchange_rate,
            gas_price,
            token_decimals,
        }) = oracle;

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

impl AccessControl for Igp {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default, Clone)]
pub struct RemoteGasData {
    pub token_exchange_rate: u128,
    pub gas_price: u128,
    pub token_decimals: u8,
}

/// A discriminator used to easily identify gas payment accounts.
/// This is the first 8 bytes of the account data.
pub const GAS_PAYMENT_DISCRIMINATOR: &[u8; 8] = b"GASPAYMT";

pub type GasPayment = DiscriminatorPrefixed<GasPaymentData>;

impl DiscriminatorData for GasPaymentData {
    const DISCRIMINATOR: [u8; 8] = *GAS_PAYMENT_DISCRIMINATOR;
}

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct GasPaymentData {
    pub sequence_number: u64,
    pub igp: Pubkey,
    pub destination_domain: u32,
    pub message_id: H256,
    pub gas_amount: u64,
    pub slot: Slot,
}

impl SizedData for GasPaymentData {
    fn size(&self) -> usize {
        // 8 for discriminator
        // 8 for sequence_number
        // 32 for igp
        // 4 for destination_domain
        // 32 for message_id
        // 8 for gas_amount
        // 8 for slot
        8 + 32 + 8 + 4 + 32 + 8 + 8
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
