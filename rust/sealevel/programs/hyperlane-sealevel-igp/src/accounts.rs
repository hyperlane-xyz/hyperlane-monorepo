//! Interchain gas paymaster accounts.

use std::{cmp::Ordering, collections::HashMap};

use access_control::AccessControl;
use account_utils::{AccountData, DiscriminatorData, DiscriminatorPrefixed, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{clock::Slot, program_error::ProgramError, pubkey::Pubkey};

use hyperlane_core::{H256, U256};

use crate::error::Error;

/// The scale for token exchange rates, i.e. a token exchange rate of 1.0 is
/// represented as 10^19.
pub const TOKEN_EXCHANGE_RATE_SCALE: u128 = 10u128.pow(19);
/// The number of decimals for the native SOL token.
pub const SOL_DECIMALS: u8 = 9;

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
/// Types of IGPs that exist.
pub enum InterchainGasPaymasterType {
    /// An IGP with gas oracles and that receives lamports as payment.
    Igp(Pubkey),
    /// An overhead IGP that points to an inner IGP and imposes a gas overhead for each destination domain.
    OverheadIgp(Pubkey),
}

impl InterchainGasPaymasterType {
    /// Returns the key for the IGP.
    pub fn key(&self) -> &Pubkey {
        match self {
            InterchainGasPaymasterType::Igp(key) => key,
            InterchainGasPaymasterType::OverheadIgp(key) => key,
        }
    }
}

/// A gas oracle that provides gas data for a remote chain.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub enum GasOracle {
    /// Remote gas data stored directly in the variant data.
    RemoteGasData(RemoteGasData),
    // Future gas oracle variants could include a Pyth type, generalized CPI type, etc.
}

impl Default for GasOracle {
    fn default() -> Self {
        GasOracle::RemoteGasData(RemoteGasData::default())
    }
}

/// The account for the program's global data.
pub type ProgramDataAccount = AccountData<DiscriminatorPrefixed<ProgramData>>;

impl DiscriminatorData for ProgramData {
    const DISCRIMINATOR: [u8; 8] = *b"PRGMDATA";
}

/// A singleton account that stores the program's global data.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct ProgramData {
    /// The bump seed for the program data PDA.
    pub bump_seed: u8,
    /// The number of gas payments made by in the program.
    pub payment_count: u64,
}

impl SizedData for ProgramData {
    fn size(&self) -> usize {
        // 1 for bump_seed
        // 8 for payment_count
        1 + 8
    }
}

/// An overhead IGP account.
pub type OverheadIgpAccount = AccountData<DiscriminatorPrefixed<OverheadIgp>>;

impl DiscriminatorData for OverheadIgp {
    const DISCRIMINATOR: [u8; 8] = *b"OVRHDIGP";
}

/// Overhead IGP account data, intended to be configured with gas overheads
/// to impose on application-specified gas payment amounts.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct OverheadIgp {
    /// The bump seed for the overhead IGP PDA.
    pub bump_seed: u8,
    /// The salt used to derive the overhead IGP PDA.
    pub salt: H256,
    /// The owner of the overhead IGP.
    pub owner: Option<Pubkey>,
    /// The inner IGP account.
    pub inner: Pubkey,
    /// The gas overheads to impose on gas payments to each destination domain.
    pub gas_overheads: HashMap<u32, u64>,
}

impl OverheadIgp {
    /// Returns the gas overhead to impose on gas payments to the given
    /// destination domain. Defaults to 0 if a gas overhead is not set for the domain.
    pub fn gas_overhead(&self, destination_domain: u32) -> u64 {
        self.gas_overheads
            .get(&destination_domain)
            .copied()
            .unwrap_or(0)
    }

    /// Quotes a gas payment, considering the gas overhead if one is present.
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

/// An IGP account.
pub type IgpAccount = AccountData<DiscriminatorPrefixed<Igp>>;

impl DiscriminatorData for Igp {
    const DISCRIMINATOR: [u8; 8] = *b"IGP_____";
}

/// IGP account data.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct Igp {
    /// The bump seed for the IGP PDA.
    pub bump_seed: u8,
    /// The salt used to derive the IGP PDA.
    pub salt: H256,
    /// The owner of the IGP.
    pub owner: Option<Pubkey>,
    /// The beneficiary of the IGP.
    pub beneficiary: Pubkey,
    /// The gas oracles for each destination domain.
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
    /// Quotes a gas payment.
    /// Returns an error if a gas oracle is not set for the destination domain.
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

/// Remote gas data.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct RemoteGasData {
    /// The token exchange rate for the remote token, adjusted by the
    /// TOKEN_EXCHANGE_RATE_SCALE.
    /// If this e.g. 0.2, then one local token would give you 5 remote tokens.
    #[cfg_attr(feature = "serde", serde(with = "hyperlane_core::utils::serde_u128"))]
    pub token_exchange_rate: u128,
    /// The gas price for the remote chain.
    #[cfg_attr(feature = "serde", serde(with = "hyperlane_core::utils::serde_u128"))]
    pub gas_price: u128,
    /// The number of decimals for the remote token.
    pub token_decimals: u8,
}

/// A discriminator used to easily identify gas payment accounts.
/// This is the first 8 bytes of the account data.
pub const GAS_PAYMENT_DISCRIMINATOR: &[u8; 8] = b"GASPAYMT";

/// A gas payment account, relating to a single gas payment.
pub type GasPaymentAccount = AccountData<GasPayment>;

/// Gas payment account data, prefixed with a discriminator.
pub type GasPayment = DiscriminatorPrefixed<GasPaymentData>;

impl DiscriminatorData for GasPaymentData {
    const DISCRIMINATOR: [u8; 8] = *GAS_PAYMENT_DISCRIMINATOR;
}

/// Gas payment account data.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct GasPaymentData {
    /// The sequence number of the gas payment.
    pub sequence_number: u64,
    /// The IGP that the gas payment is for.
    pub igp: Pubkey,
    /// The destination domain of the gas payment.
    pub destination_domain: u32,
    /// The message ID of the gas payment.
    pub message_id: H256,
    /// The amount of gas provided.
    pub gas_amount: u64,
    /// The amount of lamports quoted and paid.
    pub payment: u64,
    /// The unique gas payment pubkey.
    pub unique_gas_payment_pubkey: Pubkey,
    /// The slot of the gas payment.
    pub slot: Slot,
}

impl SizedData for GasPaymentData {
    fn size(&self) -> usize {
        // 8 for sequence_number
        // 32 for igp
        // 4 for destination_domain
        // 32 for message_id
        // 8 for gas_amount
        // 32 for unique_gas_payment_pubkey
        // 8 for slot
        8 + 32 + 4 + 32 + 8 + 8 + 32 + 8
    }
}

/// Converts `num` from `from_decimals` to `to_decimals`.
fn convert_decimals(num: U256, from_decimals: u8, to_decimals: u8) -> U256 {
    match from_decimals.cmp(&to_decimals) {
        Ordering::Greater => num / U256::from(10u64).pow(U256::from(from_decimals - to_decimals)),
        Ordering::Less => num * U256::from(10u64).pow(U256::from(to_decimals - from_decimals)),
        Ordering::Equal => num,
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_convert_decimals() {
        let num = U256::from(1000000u128);
        let from_decimals = 9;
        let to_decimals = 9;
        let result = convert_decimals(num, from_decimals, to_decimals);
        assert_eq!(result, num);

        let num = U256::from(1000000000000000u128);
        let from_decimals = 18;
        let to_decimals = 9;
        let result = convert_decimals(num, from_decimals, to_decimals);
        assert_eq!(result, U256::from(1000000u128));

        let num = U256::from(1000000u128);
        let from_decimals = 4;
        let to_decimals = 9;
        let result = convert_decimals(num, from_decimals, to_decimals);
        assert_eq!(result, U256::from(100000000000u128));

        // Some loss of precision
        let num = U256::from(9999999u128);
        let from_decimals = 9;
        let to_decimals = 4;
        let result = convert_decimals(num, from_decimals, to_decimals);
        assert_eq!(result, U256::from(99u128));

        // Total loss of precision
        let num = U256::from(999u128);
        let from_decimals = 9;
        let to_decimals = 4;
        let result = convert_decimals(num, from_decimals, to_decimals);
        assert_eq!(result, U256::from(0u128));
    }
}
