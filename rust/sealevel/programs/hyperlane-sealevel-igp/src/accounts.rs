//! Interchain gas paymaster accounts.

use std::{
    cmp::Ordering,
    collections::{BTreeSet, HashMap},
};

use access_control::AccessControl;
use account_utils::{
    read_optional_trailing, AccountData, DiscriminatorData, DiscriminatorPrefixed, SizedData,
};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H160, H256, U256};
use quote_verifier::ValidatableQuote;
use solana_program::{clock::Slot, program_error::ProgramError, pubkey::Pubkey};

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
    ) -> Result<u64, ProgramError> {
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
/// `BorshSerialize` and `BorshDeserialize` are implemented manually to support
/// backward-compatible (de)serialization of accounts created before `fee_config`
/// was added. When `fee_config` is `None`, no trailing bytes are written so the
/// serialized size matches the pre-upgrade layout exactly.
#[derive(Debug, PartialEq, Default)]
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
    /// Offchain quoting configuration. None = quoting disabled (oracle-only).
    /// Managed via SetIgpQuoteConfig. Trailing field for backward compat.
    pub fee_config: Option<IgpFeeConfig>,
}

impl BorshSerialize for Igp {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        self.bump_seed.serialize(writer)?;
        self.salt.serialize(writer)?;
        self.owner.serialize(writer)?;
        self.beneficiary.serialize(writer)?;
        self.gas_oracles.serialize(writer)?;
        // Only write the Option tag + payload when Some; write nothing for None
        // so the serialized size matches the pre-upgrade layout.
        if let Some(cfg) = &self.fee_config {
            1u8.serialize(writer)?;
            cfg.serialize(writer)?;
        }
        Ok(())
    }
}

impl BorshDeserialize for Igp {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let bump_seed = u8::deserialize_reader(reader)?;
        let salt = H256::deserialize_reader(reader)?;
        let owner = Option::<Pubkey>::deserialize_reader(reader)?;
        let beneficiary = Pubkey::deserialize_reader(reader)?;
        let gas_oracles = HashMap::<u32, GasOracle>::deserialize_reader(reader)?;
        let fee_config = read_optional_trailing::<_, IgpFeeConfig>(reader)?;
        Ok(Self {
            bump_seed,
            salt,
            owner,
            beneficiary,
            gas_oracles,
            fee_config,
        })
    }
}

impl SizedData for Igp {
    fn size(&self) -> usize {
        // 1 for bump_seed
        // 32 for salt
        // 33 for owner (1 byte Option, 32 bytes for pubkey)
        // 32 for beneficiary
        // 4 for gas_oracles.len()
        // M * (4 + (1 + 257)) for gas_oracles contents
        1 + 32
            + 33
            + 32
            + 4
            + (self.gas_oracles.len() * (1 + 257))
            + match &self.fee_config {
                Some(cfg) => 1 + cfg.size(),
                None => 0,
            }
    }
}

impl Igp {
    /// Quotes a gas payment.
    /// Returns an error if a gas oracle is not set for the destination domain.
    pub fn quote_gas_payment(
        &self,
        destination_domain: u32,
        gas_amount: u64,
    ) -> Result<u64, ProgramError> {
        let oracle = self
            .gas_oracles
            .get(&destination_domain)
            .ok_or(Error::NoGasOracleSetForDestinationDomain)?;
        let GasOracle::RemoteGasData(data) = oracle;

        compute_gas_fee(
            data.token_exchange_rate,
            data.gas_price,
            gas_amount,
            data.token_decimals,
        )
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

// --- IGP quoting types ---

/// Borsh serialized size of Pubkey (32 bytes).
const PUBKEY_SIZE: usize = 32;

/// Borsh serialized size of H256 (32 bytes).
const H256_SIZE: usize = 32;

/// Borsh serialized size of H160 (20 bytes).
const H160_SIZE: usize = 20;

/// Borsh serialized size of a Vec/Map/Set length prefix (u32).
const BORSH_LEN_PREFIX: usize = std::mem::size_of::<u32>();

/// Wildcard sender: matches any sender in standing quote PDA lookups.
pub const WILDCARD_SENDER: Pubkey = Pubkey::new_from_array([0xFF; 32]);

/// Wildcard domain: matches any destination domain in standing quote PDA lookups.
pub const WILDCARD_DOMAIN: u32 = u32::MAX;

// --- IGP quote context and data parsing ---

/// Expected size of the IGP quote context bytes.
/// Layout: [0:32] fee_token_mint | [32:36] destination_domain (u32 LE) | [36:68] sender
pub const IGP_QUOTE_CONTEXT_SIZE: usize = PUBKEY_SIZE + std::mem::size_of::<u32>() + PUBKEY_SIZE;

/// Expected size of the IGP quote data bytes.
/// Layout: [0:16] token_exchange_rate (u128 LE) | [16:32] gas_price (u128 LE) | [32:33] token_decimals (u8)
pub const IGP_QUOTE_DATA_SIZE: usize =
    std::mem::size_of::<u128>() + std::mem::size_of::<u128>() + std::mem::size_of::<u8>();

/// Parsed IGP quote context from signed quote context bytes.
#[derive(Debug, PartialEq)]
pub struct IgpQuoteContext {
    /// Fee token mint (Pubkey::default() for SOL).
    pub fee_token_mint: Pubkey,
    /// Hyperlane destination domain.
    pub destination_domain: u32,
    /// Sender program ID for per-sender pricing.
    pub sender: Pubkey,
}

impl TryFrom<&[u8]> for IgpQuoteContext {
    type Error = ProgramError;

    fn try_from(bytes: &[u8]) -> Result<Self, Self::Error> {
        if bytes.len() != IGP_QUOTE_CONTEXT_SIZE {
            return Err(Error::InvalidIgpQuoteContext.into());
        }

        Ok(Self {
            fee_token_mint: Pubkey::try_from(&bytes[..32])
                .map_err(|_| Error::InvalidIgpQuoteContext)?,
            destination_domain: u32::from_le_bytes(
                bytes[32..36]
                    .try_into()
                    .map_err(|_| Error::InvalidIgpQuoteContext)?,
            ),
            sender: Pubkey::try_from(&bytes[36..68]).map_err(|_| Error::InvalidIgpQuoteContext)?,
        })
    }
}

/// Parsed IGP quote data from signed quote data bytes.
#[derive(Debug, PartialEq)]
pub struct IgpQuoteData {
    /// Token exchange rate, scaled by TOKEN_EXCHANGE_RATE_SCALE (10^19).
    pub token_exchange_rate: u128,
    /// Gas price on the remote chain.
    pub gas_price: u128,
    /// Remote token decimals for decimal conversion.
    pub token_decimals: u8,
}

impl TryFrom<&[u8]> for IgpQuoteData {
    type Error = ProgramError;

    fn try_from(bytes: &[u8]) -> Result<Self, Self::Error> {
        if bytes.len() != IGP_QUOTE_DATA_SIZE {
            return Err(Error::InvalidIgpQuoteData.into());
        }

        Ok(Self {
            token_exchange_rate: u128::from_le_bytes(
                bytes[..16]
                    .try_into()
                    .map_err(|_| Error::InvalidIgpQuoteData)?,
            ),
            gas_price: u128::from_le_bytes(
                bytes[16..32]
                    .try_into()
                    .map_err(|_| Error::InvalidIgpQuoteData)?,
            ),
            token_decimals: bytes[32],
        })
    }
}

/// Configuration for offchain quoting on an IGP account.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone, Default)]
pub struct IgpFeeConfig {
    /// Authorized secp256k1 signer addresses for quote submission.
    pub signers: BTreeSet<H160>,
    /// Hyperlane domain ID for cross-chain replay prevention in signing messages.
    pub domain_id: u32,
    /// Emergency revocation threshold: reject quotes with issued_at below this value.
    pub min_issued_at: i64,
}

impl SizedData for IgpFeeConfig {
    fn size(&self) -> usize {
        BORSH_LEN_PREFIX + (self.signers.len() * H160_SIZE)
            + std::mem::size_of::<u32>()  // domain_id
            + std::mem::size_of::<i64>() // min_issued_at
    }
}

// --- Standing quote PDA ---

/// AccountData wrapper for IgpStandingQuote.
pub type IgpStandingQuoteAccount = AccountData<DiscriminatorPrefixed<IgpStandingQuote>>;

impl DiscriminatorData for IgpStandingQuote {
    const DISCRIMINATOR: [u8; 8] = *b"IGPSTQTE";
}

/// Standing quote data for a specific (igp, fee_token_mint, domain, sender) combination.
/// Context fields are stored for PDA re-derivation in CloseIgpStandingQuote.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone, Default)]
pub struct IgpStandingQuote {
    /// PDA bump seed.
    pub bump_seed: u8,
    /// Fee token mint (Pubkey::default() for SOL). Stored for PDA re-derivation.
    pub fee_token_mint: Pubkey,
    /// Destination domain. Stored for PDA re-derivation.
    pub destination_domain: u32,
    /// Sender (warp route program ID). Stored for PDA re-derivation.
    pub sender: Pubkey,
    /// Token exchange rate, scaled by TOKEN_EXCHANGE_RATE_SCALE (10^19).
    pub token_exchange_rate: u128,
    /// Gas price on the remote chain.
    pub gas_price: u128,
    /// Remote token decimals (same role as RemoteGasData.token_decimals).
    pub token_decimals: u8,
    /// When the quote was issued (unix timestamp).
    pub issued_at: i64,
    /// When the quote expires (unix timestamp).
    pub expiry: i64,
}

impl SizedData for IgpStandingQuote {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()       // bump_seed
            + PUBKEY_SIZE               // fee_token_mint
            + std::mem::size_of::<u32>() // destination_domain
            + PUBKEY_SIZE               // sender
            + std::mem::size_of::<u128>() // token_exchange_rate
            + std::mem::size_of::<u128>() // gas_price
            + std::mem::size_of::<u8>()  // token_decimals
            + std::mem::size_of::<i64>() // issued_at
            + std::mem::size_of::<i64>() // expiry
    }
}

impl ValidatableQuote for IgpStandingQuote {
    fn expiry(&self) -> i64 {
        self.expiry
    }

    fn issued_at(&self) -> i64 {
        self.issued_at
    }
}

// --- Transient quote PDA ---

/// AccountData wrapper for IgpTransientQuote.
pub type IgpTransientQuoteAccount = AccountData<DiscriminatorPrefixed<IgpTransientQuote>>;

impl DiscriminatorData for IgpTransientQuote {
    const DISCRIMINATOR: [u8; 8] = *b"IGPTQOTE";
}

/// Transient quote data, created and consumed in the same transaction.
/// Keyed by (igp_account, scoped_salt) where scoped_salt = keccak256(payer || client_salt).
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone, Default)]
pub struct IgpTransientQuote {
    /// PDA bump seed.
    pub bump_seed: u8,
    /// Payer who created the transient quote (receives rent refund on autoclose).
    pub payer: Pubkey,
    /// Scoped salt: keccak256(payer || client_salt).
    pub scoped_salt: H256,
    /// Destination domain from the quote context.
    pub destination_domain: u32,
    /// Sender (warp route program ID) from the quote context.
    pub sender: Pubkey,
    /// Token exchange rate, scaled by TOKEN_EXCHANGE_RATE_SCALE (10^19).
    pub token_exchange_rate: u128,
    /// Gas price on the remote chain.
    pub gas_price: u128,
    /// Remote token decimals.
    pub token_decimals: u8,
    /// Expiry timestamp (equals issued_at for transient quotes).
    pub expiry: i64,
}

impl SizedData for IgpTransientQuote {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()       // bump_seed
            + PUBKEY_SIZE               // payer
            + H256_SIZE                 // scoped_salt
            + std::mem::size_of::<u32>() // destination_domain
            + PUBKEY_SIZE               // sender
            + std::mem::size_of::<u128>() // token_exchange_rate
            + std::mem::size_of::<u128>() // gas_price
            + std::mem::size_of::<u8>()  // token_decimals
            + std::mem::size_of::<i64>() // expiry
    }
}

impl ValidatableQuote for IgpTransientQuote {
    fn expiry(&self) -> i64 {
        self.expiry
    }

    fn issued_at(&self) -> i64 {
        // Transient quotes have expiry == issued_at by construction.
        self.expiry
    }
}

/// Resolved quote values from the cascade.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedQuote {
    /// Token exchange rate, scaled by TOKEN_EXCHANGE_RATE_SCALE (10^19).
    pub token_exchange_rate: u128,
    /// Gas price on the remote chain.
    pub gas_price: u128,
    /// Remote token decimals for decimal conversion.
    pub token_decimals: u8,
}

/// Computes the gas fee from quote parameters.
/// Same formula as the on-chain oracle path but with checked u64 conversion.
pub fn compute_gas_fee(
    token_exchange_rate: u128,
    gas_price: u128,
    gas_amount: u64,
    token_decimals: u8,
) -> Result<u64, ProgramError> {
    let dest_cost = U256::from(gas_amount) * U256::from(gas_price);
    let origin_cost =
        (dest_cost * U256::from(token_exchange_rate)) / U256::from(TOKEN_EXCHANGE_RATE_SCALE);
    let origin_cost = convert_decimals(origin_cost, token_decimals, SOL_DECIMALS);

    u64::try_from(origin_cost).map_err(|_| ProgramError::ArithmeticOverflow)
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

    // --- IgpFeeConfig ---

    #[test]
    fn test_igp_fee_config_borsh_roundtrip() {
        let config = IgpFeeConfig {
            signers: BTreeSet::from([H160::random(), H160::random()]),
            domain_id: 42,
            min_issued_at: 1000,
        };
        let encoded = borsh::to_vec(&config).unwrap();
        let decoded: IgpFeeConfig = borsh::from_slice(&encoded).unwrap();
        assert_eq!(config, decoded);
    }

    #[test]
    fn test_igp_fee_config_sized_data_empty() {
        let config = IgpFeeConfig::default();
        assert_eq!(config.size(), borsh::to_vec(&config).unwrap().len());
    }

    #[test]
    fn test_igp_fee_config_sized_data_with_signers() {
        let config = IgpFeeConfig {
            signers: BTreeSet::from([H160::random(), H160::random(), H160::random()]),
            domain_id: 1,
            min_issued_at: 500,
        };
        assert_eq!(config.size(), borsh::to_vec(&config).unwrap().len());
    }

    // --- IgpStandingQuote ---

    #[test]
    fn test_igp_standing_quote_borsh_roundtrip() {
        let quote = IgpStandingQuote {
            bump_seed: 1,
            fee_token_mint: Pubkey::default(),
            destination_domain: 137,
            sender: Pubkey::new_unique(),
            token_exchange_rate: 2_000_000_000_000_000_000,
            gas_price: 50_000_000_000,
            token_decimals: 18,
            issued_at: 1000,
            expiry: 2000,
        };
        let encoded = borsh::to_vec(&quote).unwrap();
        let decoded: IgpStandingQuote = borsh::from_slice(&encoded).unwrap();
        assert_eq!(quote, decoded);
    }

    #[test]
    fn test_igp_standing_quote_sized_data() {
        let quote = IgpStandingQuote {
            bump_seed: 1,
            fee_token_mint: Pubkey::default(),
            destination_domain: 137,
            sender: Pubkey::new_unique(),
            token_exchange_rate: 2_000_000_000_000_000_000,
            gas_price: 50_000_000_000,
            token_decimals: 18,
            issued_at: 1000,
            expiry: 2000,
        };
        assert_eq!(quote.size(), borsh::to_vec(&quote).unwrap().len());
    }

    // --- IgpTransientQuote ---

    #[test]
    fn test_igp_transient_quote_borsh_roundtrip() {
        let quote = IgpTransientQuote {
            bump_seed: 2,
            payer: Pubkey::new_unique(),
            scoped_salt: H256::random(),
            destination_domain: 42,
            sender: Pubkey::new_unique(),
            token_exchange_rate: 1_000_000_000_000_000_000,
            gas_price: 25_000_000_000,
            token_decimals: 9,
            expiry: 500,
        };
        let encoded = borsh::to_vec(&quote).unwrap();
        let decoded: IgpTransientQuote = borsh::from_slice(&encoded).unwrap();
        assert_eq!(quote, decoded);
    }

    #[test]
    fn test_igp_transient_quote_sized_data() {
        let quote = IgpTransientQuote {
            bump_seed: 2,
            payer: Pubkey::new_unique(),
            scoped_salt: H256::random(),
            destination_domain: 42,
            sender: Pubkey::new_unique(),
            token_exchange_rate: 1_000_000_000_000_000_000,
            gas_price: 25_000_000_000,
            token_decimals: 9,
            expiry: 500,
        };
        assert_eq!(quote.size(), borsh::to_vec(&quote).unwrap().len());
    }

    // --- Igp backward-compat deserialization ---

    #[test]
    fn test_igp_borsh_roundtrip_with_fee_config() {
        let igp = Igp {
            bump_seed: 1,
            salt: H256::random(),
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            gas_oracles: HashMap::new(),
            fee_config: Some(IgpFeeConfig {
                signers: BTreeSet::from([H160::random()]),
                domain_id: 42,
                min_issued_at: 1000,
            }),
        };
        let encoded = borsh::to_vec(&igp).unwrap();
        let decoded: Igp = borsh::from_slice(&encoded).unwrap();
        assert_eq!(igp, decoded);
    }

    #[test]
    fn test_igp_borsh_roundtrip_without_fee_config() {
        let igp = Igp {
            bump_seed: 1,
            salt: H256::random(),
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            gas_oracles: HashMap::new(),
            fee_config: None,
        };
        let encoded = borsh::to_vec(&igp).unwrap();
        let decoded: Igp = borsh::from_slice(&encoded).unwrap();
        assert_eq!(igp, decoded);
    }

    #[test]
    fn test_igp_backward_compat_deserialize_without_fee_config() {
        // Custom BorshSerialize writes nothing for fee_config: None,
        // producing the same byte layout as pre-upgrade accounts.
        let igp = Igp {
            bump_seed: 1,
            salt: H256::random(),
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            gas_oracles: HashMap::new(),
            fee_config: None,
        };
        let encoded = borsh::to_vec(&igp).unwrap();
        // No trailing Option tag — matches old format exactly.
        let mut reader = encoded.as_slice();
        let deserialized = Igp::deserialize_reader(&mut reader).unwrap();
        assert_eq!(deserialized.fee_config, None);
        assert_eq!(deserialized.bump_seed, igp.bump_seed);
        assert_eq!(deserialized.beneficiary, igp.beneficiary);
    }

    #[test]
    fn test_igp_sized_data_with_fee_config() {
        let igp = Igp {
            bump_seed: 1,
            salt: H256::random(),
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            gas_oracles: HashMap::new(),
            fee_config: Some(IgpFeeConfig {
                signers: BTreeSet::from([H160::random(), H160::random()]),
                domain_id: 42,
                min_issued_at: 1000,
            }),
        };
        assert_eq!(igp.size(), borsh::to_vec(&igp).unwrap().len());
    }

    #[test]
    fn test_igp_sized_data_without_fee_config() {
        let igp = Igp {
            bump_seed: 1,
            salt: H256::random(),
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            gas_oracles: HashMap::new(),
            fee_config: None,
        };
        assert_eq!(igp.size(), borsh::to_vec(&igp).unwrap().len());
    }

    // --- IgpQuoteContext parsing ---

    #[test]
    fn test_igp_quote_context_try_from_valid() {
        let mint = Pubkey::new_unique();
        let sender = Pubkey::new_unique();
        let domain: u32 = 137;

        let mut bytes = Vec::with_capacity(IGP_QUOTE_CONTEXT_SIZE);
        bytes.extend_from_slice(mint.as_ref());
        bytes.extend_from_slice(&domain.to_le_bytes());
        bytes.extend_from_slice(sender.as_ref());

        let ctx = IgpQuoteContext::try_from(bytes.as_slice()).unwrap();
        assert_eq!(ctx.fee_token_mint, mint);
        assert_eq!(ctx.destination_domain, domain);
        assert_eq!(ctx.sender, sender);
    }

    #[test]
    fn test_igp_quote_context_try_from_wrong_length() {
        let result = IgpQuoteContext::try_from(&[0u8; 10][..]);
        assert_eq!(
            result.unwrap_err(),
            ProgramError::Custom(Error::InvalidIgpQuoteContext as u32),
        );
    }

    // --- IgpQuoteData parsing ---

    #[test]
    fn test_igp_quote_data_try_from_valid() {
        let exchange_rate: u128 = 2_000_000_000_000_000_000;
        let gas_price: u128 = 50_000_000_000;
        let decimals: u8 = 18;

        let mut bytes = Vec::with_capacity(IGP_QUOTE_DATA_SIZE);
        bytes.extend_from_slice(&exchange_rate.to_le_bytes());
        bytes.extend_from_slice(&gas_price.to_le_bytes());
        bytes.push(decimals);

        let data = IgpQuoteData::try_from(bytes.as_slice()).unwrap();
        assert_eq!(data.token_exchange_rate, exchange_rate);
        assert_eq!(data.gas_price, gas_price);
        assert_eq!(data.token_decimals, decimals);
    }

    #[test]
    fn test_igp_quote_data_try_from_wrong_length() {
        let result = IgpQuoteData::try_from(&[0u8; 5][..]);
        assert_eq!(
            result.unwrap_err(),
            ProgramError::Custom(Error::InvalidIgpQuoteData as u32),
        );
    }

    // --- compute_gas_fee ---

    #[test]
    fn test_compute_gas_fee_matches_oracle_path() {
        // Same inputs as the oracle would provide — result must match.
        let exchange_rate: u128 = 10u128.pow(19); // 1:1
        let gas_price: u128 = 1_000_000_000; // 1 gwei
        let gas_amount: u64 = 100_000;
        let token_decimals: u8 = 9; // same as SOL

        let result = compute_gas_fee(exchange_rate, gas_price, gas_amount, token_decimals).unwrap();

        // Manual: 100_000 * 1e9 * 1e19 / 1e19 = 100_000 * 1e9 = 1e14
        // convert_decimals(1e14, 9, 9) = 1e14
        assert_eq!(result, 100_000_000_000_000);
    }

    #[test]
    fn test_compute_gas_fee_with_decimal_conversion() {
        let exchange_rate: u128 = 10u128.pow(19);
        let gas_price: u128 = 1_000_000_000;
        let gas_amount: u64 = 100_000;
        let token_decimals: u8 = 18; // remote has 18 decimals, local has 9

        let result = compute_gas_fee(exchange_rate, gas_price, gas_amount, token_decimals).unwrap();

        // convert_decimals divides by 10^(18-9) = 10^9
        assert_eq!(result, 100_000);
    }

    #[test]
    fn test_compute_gas_fee_overflow_returns_error() {
        // Values that produce a result > u64::MAX but within U256 range.
        // exchange_rate=1e19, gas_price=1e18, gas_amount=u64::MAX, decimals=0
        // result = u64::MAX * 1e18 * 1e19 / 1e19 = u64::MAX * 1e18 >> u64::MAX
        let result = compute_gas_fee(10u128.pow(19), 10u128.pow(18), u64::MAX, 0);
        assert_eq!(result.unwrap_err(), ProgramError::ArithmeticOverflow);
    }

    // --- Existing tests ---

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
