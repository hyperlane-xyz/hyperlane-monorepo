//! Fee program account structures.

use std::collections::{BTreeMap, BTreeSet};

use access_control::AccessControl;
use account_utils::{AccountData, DiscriminatorData, DiscriminatorPrefixed, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H160, H256};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::fee_math::FeeDataStrategy;
use quote_verifier::{QuoteValidationError, ValidatableQuote};

// --- Discriminators ---

/// Discriminator for FeeAccount PDAs.
pub const FEE_ACCOUNT_DISCRIMINATOR: [u8; 8] = *b"FEE_ACCT";
/// Discriminator for RouteDomain PDAs.
pub const ROUTE_DOMAIN_DISCRIMINATOR: [u8; 8] = *b"ROUTEDOM";
/// Discriminator for CrossCollateralRoute PDAs.
pub const CC_ROUTE_DISCRIMINATOR: [u8; 8] = *b"CC_ROUTE";
/// Discriminator for TransientQuote PDAs.
pub const TRANSIENT_QUOTE_DISCRIMINATOR: [u8; 8] = *b"TRNQUOTE";
/// Discriminator for FeeStandingQuotePda PDAs.
pub const STANDING_QUOTE_DISCRIMINATOR: [u8; 8] = *b"STDQUOTE";

// --- Wildcard constants ---

/// Wildcard recipient for standing quotes: matches any end-user destination address.
pub const WILDCARD_RECIPIENT: H256 = H256::repeat_byte(0xFF);

/// Wildcard destination domain for standing quotes: matches any Hyperlane domain ID.
pub const WILDCARD_DOMAIN: u32 = u32::MAX;

/// Default target router for CC routing fallback when no specific (dest, target_router) match.
/// Value is `keccak256("RoutingFee.DEFAULT_ROUTER")`, matching the EVM constant in
/// `CrossCollateralRoutingFee.sol`. Precomputed because `const` context cannot call keccak.
pub const DEFAULT_ROUTER: H256 = H256([
    0x6e, 0x08, 0x6c, 0xd6, 0x47, 0xd6, 0xeb, 0x8b, 0x51, 0x68, 0x56, 0x66, 0x6e, 0x2c, 0x14, 0x65,
    0xfb, 0x8a, 0x6a, 0x58, 0xd3, 0xa7, 0x59, 0x38, 0x36, 0x2a, 0xcc, 0x67, 0x4e, 0xac, 0xaf, 0x47,
]);

// --- Borsh serialized sizes for fixed-layout types ---

/// Borsh serialized size of Pubkey (32 bytes).
const PUBKEY_SIZE: usize = 32;

/// Borsh serialized size of Option<Pubkey>.
/// Some: 1 tag + 32 bytes. None: 1 tag.
fn option_pubkey_size(opt: &Option<Pubkey>) -> usize {
    1 + if opt.is_some() { PUBKEY_SIZE } else { 0 }
}
/// Borsh serialized size of H256 (32 bytes).
const H256_SIZE: usize = 32;
/// Borsh serialized size of H160 (20 bytes).
const H160_SIZE: usize = 20;
/// Borsh serialized size of a Borsh Vec/Map/Set length prefix (u32).
const BORSH_LEN_PREFIX: usize = std::mem::size_of::<u32>();

// --- Variant-specific fee config structs ---

/// Configuration for Leaf fee mode.
/// Directly computes fee from a strategy curve. Signers authorize all quotes
/// (both exact and wildcard domain).
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Default, PartialEq)]
pub struct LeafFeeConfig {
    /// Fee computation strategy (Linear, Regressive, Progressive).
    pub strategy: FeeDataStrategy,
    /// Authorized offchain quote signers. Some = offchain quoting enabled, None = on-chain only.
    pub signers: Option<BTreeSet<H160>>,
}

impl SizedData for LeafFeeConfig {
    fn size(&self) -> usize {
        SizedData::size(&self.strategy) + option_signers_size(&self.signers)
    }
}

/// Configuration for Routing fee mode.
/// Per-domain lookup via RouteDomain PDAs. Each route PDA carries its own signer set
/// for exact-domain quotes. Wildcard-domain quotes are authorized by `wildcard_signers`.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Default, PartialEq)]
pub struct RoutingFeeConfig {
    /// Signers for wildcard-domain standing quotes. Empty = no wildcard quoting.
    pub wildcard_signers: BTreeSet<H160>,
}

impl SizedData for RoutingFeeConfig {
    fn size(&self) -> usize {
        BORSH_LEN_PREFIX + (self.wildcard_signers.len() * H160_SIZE)
    }
}

/// Configuration for CrossCollateralRouting fee mode.
/// Per-(destination, target_router) lookup via CrossCollateralRoute PDAs.
/// Each route PDA carries its own signer set for exact-domain quotes.
/// Wildcard-domain quotes are authorized by `wildcard_signers`.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Default, PartialEq)]
pub struct CrossCollateralRoutingFeeConfig {
    /// Signers for wildcard-domain standing quotes. Empty = no wildcard quoting.
    pub wildcard_signers: BTreeSet<H160>,
}

impl SizedData for CrossCollateralRoutingFeeConfig {
    fn size(&self) -> usize {
        BORSH_LEN_PREFIX + (self.wildcard_signers.len() * H160_SIZE)
    }
}

// --- Top-level fee data enum ---

/// Determines how fee resolution works for a fee account.
/// Each variant carries its own signer configuration so the type system
/// enforces mode-correct usage.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub enum FeeData {
    /// Leaf fee strategy — directly computes fee from params.
    /// Signers authorize all quotes (exact and wildcard domain).
    Leaf(LeafFeeConfig),
    /// Per-domain lookup via RouteDomain PDAs.
    /// Wildcard-domain quotes authorized by `wildcard_signers`.
    Routing(RoutingFeeConfig),
    /// Per-(destination, target_router) lookup for cross-collateral warp routes.
    /// Wildcard-domain quotes authorized by `wildcard_signers`.
    CrossCollateralRouting(CrossCollateralRoutingFeeConfig),
}

impl Default for FeeData {
    fn default() -> Self {
        Self::Leaf(LeafFeeConfig::default())
    }
}

impl FeeData {
    /// Returns a reference to the leaf signer set, or error if not configured.
    pub fn require_leaf_signers(&self) -> Result<&BTreeSet<H160>, ProgramError> {
        match self {
            FeeData::Leaf(cfg) => cfg
                .signers
                .as_ref()
                .ok_or_else(|| crate::error::Error::OffchainQuotingNotConfigured.into()),
            _ => Err(crate::error::Error::NotLeafFeeData.into()),
        }
    }

    /// Returns a reference to the routing wildcard signer set.
    pub fn routing_wildcard_signers(&self) -> Result<&BTreeSet<H160>, ProgramError> {
        match self {
            FeeData::Routing(cfg) => Ok(&cfg.wildcard_signers),
            _ => Err(crate::error::Error::NotRoutingFeeData.into()),
        }
    }

    /// Returns a reference to the CC wildcard signer set.
    pub fn cc_wildcard_signers(&self) -> Result<&BTreeSet<H160>, ProgramError> {
        match self {
            FeeData::CrossCollateralRouting(cfg) => Ok(&cfg.wildcard_signers),
            _ => Err(crate::error::Error::NotCrossCollateralRoutingFeeData.into()),
        }
    }
}

impl SizedData for FeeData {
    fn size(&self) -> usize {
        // 1 byte for enum variant tag
        1 + match self {
            FeeData::Leaf(cfg) => cfg.size(),
            FeeData::Routing(cfg) => cfg.size(),
            FeeData::CrossCollateralRouting(cfg) => cfg.size(),
        }
    }
}

// --- Fee account ---

/// AccountData wrapper for FeeAccount.
pub type FeeAccountData = AccountData<DiscriminatorPrefixed<FeeAccount>>;

impl DiscriminatorData for FeeAccount {
    const DISCRIMINATOR: [u8; 8] = FEE_ACCOUNT_DISCRIMINATOR;
}

/// The main fee account, one per warp route.
/// Created via InitFee with a salt-derived PDA.
/// Signer configuration lives inside `fee_data` (variant-specific).
#[derive(BorshDeserialize, BorshSerialize, Debug, Default, PartialEq)]
pub struct FeeAccount {
    /// PDA bump seed.
    pub bump_seed: u8,
    /// Owner who can modify fee configuration. None = immutable.
    pub owner: Option<Pubkey>,
    /// Beneficiary who receives collected token fees.
    pub beneficiary: Pubkey,
    /// Fee resolution strategy with variant-specific signer configuration.
    pub fee_data: FeeData,
    /// Hyperlane domain ID of the local chain (used in quote signature verification).
    pub domain_id: u32,
    /// Emergency revocation threshold: standing quotes with issued_at < min_issued_at are rejected.
    pub min_issued_at: i64,
}

impl AccessControl for FeeAccount {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

/// Minimal prefix of a fee account for extracting the beneficiary.
#[derive(Debug)]
pub struct FeeAccountPrefix {
    /// Beneficiary who receives collected fees.
    pub beneficiary: Pubkey,
}

impl FeeAccountPrefix {
    /// Parses the beneficiary from raw fee account data by reading fields
    /// sequentially with Borsh — no fixed offsets.
    ///
    /// On-disk layout: `[initialized (1)][discriminator (8)][bump (1)][owner (Option<Pubkey>)][beneficiary (Pubkey)]...`
    pub fn parse_from(data: &[u8]) -> Result<Self, ProgramError> {
        use account_utils::DiscriminatorData;
        use borsh::BorshDeserialize;

        // Verify initialized flag + discriminator, then skip past them.
        let prefix_len = 1 + FeeAccount::DISCRIMINATOR.len();
        if data.len() < prefix_len {
            return Err(ProgramError::InvalidAccountData);
        }

        if data[0] != 1 {
            return Err(ProgramError::UninitializedAccount);
        }

        if data[1..prefix_len] != FeeAccount::DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut reader = &data[prefix_len..];

        let _bump =
            u8::deserialize_reader(&mut reader).map_err(|_| ProgramError::InvalidAccountData)?;
        let _owner = Option::<Pubkey>::deserialize_reader(&mut reader)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        let beneficiary = Pubkey::deserialize_reader(&mut reader)
            .map_err(|_| ProgramError::InvalidAccountData)?;

        Ok(Self { beneficiary })
    }
}

/// Borsh serialized size of `Option<BTreeSet<H160>>`.
/// None: 1 tag. Some: 1 tag + 4 len prefix + count * 20.
fn option_signers_size(opt: &Option<BTreeSet<H160>>) -> usize {
    1 + match opt {
        Some(set) => BORSH_LEN_PREFIX + (set.len() * H160_SIZE),
        None => 0,
    }
}

impl SizedData for FeeAccount {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()                                                                   // bump
        + option_pubkey_size(&self.owner)                                                           // owner
        + PUBKEY_SIZE                                                                               // beneficiary
        + SizedData::size(&self.fee_data)                                                           // fee_data
        + std::mem::size_of::<u32>()                                                                // domain_id
        + std::mem::size_of::<i64>() // min_issued_at
    }
}

// --- Route domain PDA ---

/// AccountData wrapper for RouteDomain.
pub type RouteDomainAccount = AccountData<DiscriminatorPrefixed<RouteDomain>>;

impl DiscriminatorData for RouteDomain {
    const DISCRIMINATOR: [u8; 8] = ROUTE_DOMAIN_DISCRIMINATOR;
}

/// Per-destination-domain fee configuration for Routing mode.
/// PDA derived from fee_account + destination domain ID (u32 LE).
#[derive(BorshDeserialize, BorshSerialize, Debug, Default, PartialEq)]
pub struct RouteDomain {
    /// PDA bump seed.
    pub bump_seed: u8,
    /// Fee strategy for this destination domain.
    pub fee_data: FeeDataStrategy,
    /// Authorized offchain quote signers for this route.
    /// Some = offchain quoting enabled, None = on-chain fee only.
    pub signers: Option<BTreeSet<H160>>,
}

impl SizedData for RouteDomain {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()
            + SizedData::size(&self.fee_data)
            + option_signers_size(&self.signers)
    }
}

// --- Cross-collateral route PDA ---

/// AccountData wrapper for CrossCollateralRoute.
pub type CrossCollateralRouteAccount = AccountData<DiscriminatorPrefixed<CrossCollateralRoute>>;

impl DiscriminatorData for CrossCollateralRoute {
    const DISCRIMINATOR: [u8; 8] = CC_ROUTE_DISCRIMINATOR;
}

/// Per-(destination domain, target router) fee configuration for CrossCollateralRouting mode.
/// target_router is the remote warp route contract address (H256).
/// PDA derived from fee_account + destination (u32 LE) + target_router (H256).
#[derive(BorshDeserialize, BorshSerialize, Debug, Default, PartialEq)]
pub struct CrossCollateralRoute {
    /// PDA bump seed.
    pub bump_seed: u8,
    /// Fee strategy for this (destination, target_router) pair.
    pub fee_data: FeeDataStrategy,
    /// Authorized offchain quote signers for this route.
    /// Some = offchain quoting enabled, None = on-chain fee only.
    pub signers: Option<BTreeSet<H160>>,
}

impl SizedData for CrossCollateralRoute {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()
            + SizedData::size(&self.fee_data)
            + option_signers_size(&self.signers)
    }
}

// --- Transient quote PDA ---

/// AccountData wrapper for TransientQuote.
pub type TransientQuoteAccount = AccountData<DiscriminatorPrefixed<TransientQuote>>;

impl DiscriminatorData for TransientQuote {
    const DISCRIMINATOR: [u8; 8] = TRANSIENT_QUOTE_DISCRIMINATOR;
}

/// A transient quote PDA created and consumed within the same transaction.
/// Mimics EIP-1153 transient storage. Autoclosed after QuoteFee consumes it.
/// PDA derived from fee_account + scoped_salt (keccak256(payer || client_salt)).
#[derive(BorshDeserialize, BorshSerialize, Debug, Default, PartialEq)]
pub struct TransientQuote {
    /// PDA bump seed.
    pub bump_seed: u8,
    /// The payer who created this quote (binding for scoped salt verification).
    pub payer: Pubkey,
    /// keccak256(payer || client_salt) — used as PDA seed for collision prevention.
    pub scoped_salt: H256,
    /// Fee-type-specific context bytes (44B non-CC: dest_domain u32 + recipient H256 + amount u64,
    /// or 76B CC: adds target_router H256).
    pub context: Vec<u8>,
    /// Borsh-encoded `FeeDataStrategy` bytes (curve variant tag + variant-specific params).
    pub data: Vec<u8>,
    /// Expiry timestamp (unix). For transient quotes, expiry == issued_at.
    pub expiry: i64,
}

impl SizedData for TransientQuote {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()                       // bump
        + PUBKEY_SIZE                                    // payer
        + H256_SIZE                                      // scoped_salt
        + BORSH_LEN_PREFIX + self.context.len()          // context
        + BORSH_LEN_PREFIX + self.data.len()             // data
        + std::mem::size_of::<i64>() // expiry
    }
}

impl ValidatableQuote for TransientQuote {
    fn expiry(&self) -> i64 {
        self.expiry
    }

    fn issued_at(&self) -> i64 {
        // Transient quotes have expiry == issued_at by construction.
        self.expiry
    }
}

// --- Standing quote PDA ---

// --- Quote context and data parsing ---

/// Trait for quote context types. Implementations parse from raw bytes
/// and validate against the QuoteFee instruction data.
pub trait QuoteContext: Sized {
    /// Parses a QuoteContext from raw context bytes stored in a quote PDA.
    fn try_from_bytes(bytes: &[u8]) -> Result<Self, ProgramError>;
    /// Validates that the stored context matches the fields of a QuoteFee instruction.
    fn validate(&self, quote_fee: &crate::instruction::QuoteFee) -> Result<(), ProgramError>;
}

/// Quote context for Leaf and Routing fee accounts.
/// Wire format (44 bytes): dest_domain (u32 LE) + recipient (H256) + amount (u64 LE).
#[derive(Debug, PartialEq)]
pub struct FeeQuoteContext {
    /// Hyperlane domain ID of the destination chain.
    pub destination_domain: u32,
    /// End-user's address on the destination chain.
    pub recipient: H256,
    /// Transfer amount in local token units.
    pub amount: u64,
}

impl QuoteContext for FeeQuoteContext {
    fn try_from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() != std::mem::size_of::<u32>() + 32 + std::mem::size_of::<u64>() {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            destination_domain: u32::from_le_bytes(
                bytes[0..4]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            ),
            recipient: H256::from_slice(&bytes[4..36]),
            amount: u64::from_le_bytes(
                bytes[36..44]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            ),
        })
    }

    fn validate(&self, quote_fee: &crate::instruction::QuoteFee) -> Result<(), ProgramError> {
        if self.destination_domain != quote_fee.destination_domain
            || self.recipient != quote_fee.recipient
            || self.amount != quote_fee.amount
        {
            return Err(QuoteValidationError::TransientContextMismatch.into());
        }
        Ok(())
    }
}

/// Quote context for CrossCollateralRouting fee accounts.
/// Wire format (76 bytes): dest_domain (u32 LE) + recipient (H256) + amount (u64 LE) + target_router (H256).
#[derive(Debug, PartialEq)]
pub struct CcFeeQuoteContext {
    /// Hyperlane domain ID of the destination chain.
    pub destination_domain: u32,
    /// End-user's address on the destination chain.
    pub recipient: H256,
    /// Transfer amount in local token units.
    pub amount: u64,
    /// Remote warp route contract address for CC routing resolution.
    pub target_router: H256,
}

impl QuoteContext for CcFeeQuoteContext {
    fn try_from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() != std::mem::size_of::<u32>() + 32 + std::mem::size_of::<u64>() + 32 {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            destination_domain: u32::from_le_bytes(
                bytes[0..4]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            ),
            recipient: H256::from_slice(&bytes[4..36]),
            amount: u64::from_le_bytes(
                bytes[36..44]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            ),
            target_router: H256::from_slice(&bytes[44..76]),
        })
    }

    fn validate(&self, quote_fee: &crate::instruction::QuoteFee) -> Result<(), ProgramError> {
        if self.destination_domain != quote_fee.destination_domain
            || self.recipient != quote_fee.recipient
            || self.amount != quote_fee.amount
            || self.target_router != quote_fee.target_router
        {
            return Err(QuoteValidationError::TransientContextMismatch.into());
        }
        Ok(())
    }
}

/// Converts opaque quote data bytes into a FeeDataStrategy.
/// Wire format: Borsh-encoded FeeDataStrategy (1-byte variant tag + params).
/// The variant tag commits the signer to a specific curve type.
impl TryFrom<&[u8]> for FeeDataStrategy {
    type Error = ProgramError;

    fn try_from(bytes: &[u8]) -> Result<Self, Self::Error> {
        borsh::from_slice(bytes).map_err(|_| ProgramError::InvalidInstructionData)
    }
}

// --- Standing quote PDA ---

/// AccountData wrapper for FeeStandingQuotePda.
pub type FeeStandingQuotePdaAccount = AccountData<DiscriminatorPrefixed<FeeStandingQuotePda>>;

impl DiscriminatorData for FeeStandingQuotePda {
    const DISCRIMINATOR: [u8; 8] = STANDING_QUOTE_DISCRIMINATOR;
}

/// Per-destination-domain standing quote PDA. Contains a map of recipient → quote values.
/// PDA derived from fee_account + destination domain (u32 LE) + target_router (H256).
/// For Leaf/Routing: target_router = H256::zero() (sentinel).
/// For CrossCollateralRouting: target_router = actual remote warp route address.
/// Wildcard domain uses u32::MAX LE bytes.
/// Each entry is keyed by the end-user's address on the destination chain (H256).
/// Wildcard recipient uses [0xFF; 32].
#[derive(BorshDeserialize, BorshSerialize, Debug, Default, PartialEq)]
pub struct FeeStandingQuotePda {
    /// PDA bump seed.
    pub bump_seed: u8,
    /// Standing quotes keyed by recipient address on the destination chain (H256).
    /// WILDCARD_RECIPIENT ([0xFF; 32]) matches any recipient.
    pub quotes: BTreeMap<H256, FeeStandingQuoteValue>,
}

impl SizedData for FeeStandingQuotePda {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>() // bump
        + BORSH_LEN_PREFIX       // quotes BTreeMap length prefix
        + self.quotes.values().map(|v| H256_SIZE + v.size()).sum::<usize>()
    }
}

/// A standing quote value for a specific recipient on a specific destination domain.
#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, Default, PartialEq)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum StandingQuoteAuthScope {
    /// Quote was authorized directly by the current scope's signer set.
    #[default]
    Direct = 0,
    /// Quote was authorized for an exact CC route via DEFAULT_ROUTER fallback.
    CcDefaultFallback = 1,
}

/// A standing quote value for a specific recipient on a specific destination domain.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Default, PartialEq)]
pub struct FeeStandingQuoteValue {
    /// When the quote was issued (unix timestamp).
    pub issued_at: i64,
    /// When the quote expires (unix timestamp). Must be > issued_at for standing quotes.
    pub expiry: i64,
    /// Quoted fee strategy (curve variant + params). The variant tag commits the signer
    /// to a specific curve type — rejected at QuoteFee time if it doesn't match on-chain.
    pub fee_data: FeeDataStrategy,
    /// Auth provenance recorded at submission time.
    /// Used to reject CC exact-domain quotes that were authorized via DEFAULT_ROUTER
    /// once a router-specific route exists later.
    pub auth_scope: StandingQuoteAuthScope,
}

impl SizedData for FeeStandingQuoteValue {
    fn size(&self) -> usize {
        std::mem::size_of::<i64>()  // issued_at
        + std::mem::size_of::<i64>() // expiry
        + SizedData::size(&self.fee_data) // fee_data (variant tag + params)
        + std::mem::size_of::<u8>() // auth_scope
    }
}

impl ValidatableQuote for FeeStandingQuoteValue {
    fn expiry(&self) -> i64 {
        self.expiry
    }

    fn issued_at(&self) -> i64 {
        self.issued_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fee_math::FeeParams;

    // --- Borsh round-trip tests ---

    #[test]
    fn test_fee_data_borsh_roundtrip() {
        for variant in [
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: None,
            }),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        ] {
            let encoded = borsh::to_vec(&variant).unwrap();
            let decoded: FeeData = borsh::from_slice(&encoded).unwrap();
            assert_eq!(variant, decoded);
        }
    }

    #[test]
    fn test_fee_data_borsh_roundtrip_with_signers() {
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());

        for variant in [
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: Some(signers.clone()),
            }),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: signers.clone(),
            }),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: signers.clone(),
            }),
        ] {
            let encoded = borsh::to_vec(&variant).unwrap();
            let decoded: FeeData = borsh::from_slice(&encoded).unwrap();
            assert_eq!(variant, decoded);
        }
    }

    #[test]
    fn test_fee_account_borsh_roundtrip() {
        let account = FeeAccount {
            bump_seed: 255,
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
            domain_id: 42,
            min_issued_at: 0,
        };
        let encoded = borsh::to_vec(&account).unwrap();
        let decoded: FeeAccount = borsh::from_slice(&encoded).unwrap();
        assert_eq!(account, decoded);
    }

    #[test]
    fn test_fee_account_borsh_roundtrip_leaf_with_signers() {
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        let account = FeeAccount {
            bump_seed: 1,
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: Some(signers),
            }),
            domain_id: 1,
            min_issued_at: 0,
        };
        let encoded = borsh::to_vec(&account).unwrap();
        let decoded: FeeAccount = borsh::from_slice(&encoded).unwrap();
        assert_eq!(account, decoded);
    }

    #[test]
    fn test_route_domain_borsh_roundtrip() {
        let route = RouteDomain {
            bump_seed: 1,
            fee_data: FeeDataStrategy::Regressive(FeeParams {
                max_fee: 500,
                half_amount: 250,
            }),
            signers: None,
        };
        let encoded = borsh::to_vec(&route).unwrap();
        let decoded: RouteDomain = borsh::from_slice(&encoded).unwrap();
        assert_eq!(route, decoded);
    }

    #[test]
    fn test_route_domain_borsh_roundtrip_with_signers() {
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        let route = RouteDomain {
            bump_seed: 1,
            fee_data: FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
            signers: Some(signers),
        };
        let encoded = borsh::to_vec(&route).unwrap();
        let decoded: RouteDomain = borsh::from_slice(&encoded).unwrap();
        assert_eq!(route, decoded);
    }

    #[test]
    fn test_cc_route_borsh_roundtrip() {
        let route = CrossCollateralRoute {
            bump_seed: 2,
            fee_data: FeeDataStrategy::Progressive(FeeParams {
                max_fee: 1000,
                half_amount: 500,
            }),
            signers: None,
        };
        let encoded = borsh::to_vec(&route).unwrap();
        let decoded: CrossCollateralRoute = borsh::from_slice(&encoded).unwrap();
        assert_eq!(route, decoded);
    }

    #[test]
    fn test_transient_quote_borsh_roundtrip() {
        let quote = TransientQuote {
            bump_seed: 3,
            payer: Pubkey::new_unique(),
            scoped_salt: H256::random(),
            context: vec![1, 2, 3, 4],
            data: vec![5, 6, 7, 8],
            expiry: 1234567890,
            ..Default::default()
        };
        let encoded = borsh::to_vec(&quote).unwrap();
        let decoded: TransientQuote = borsh::from_slice(&encoded).unwrap();
        assert_eq!(quote, decoded);
    }

    #[test]
    fn test_standing_quote_pda_borsh_roundtrip() {
        let mut quotes = BTreeMap::new();
        quotes.insert(
            H256::zero(),
            FeeStandingQuoteValue {
                issued_at: 100,
                expiry: 200,
                fee_data: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 1000,
                    half_amount: 500,
                }),
                ..Default::default()
            },
        );
        quotes.insert(
            WILDCARD_RECIPIENT,
            FeeStandingQuoteValue {
                issued_at: 100,
                expiry: 300,
                fee_data: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 2000,
                    half_amount: 1000,
                }),
                ..Default::default()
            },
        );
        let pda = FeeStandingQuotePda {
            bump_seed: 4,
            quotes,
        };
        let encoded = borsh::to_vec(&pda).unwrap();
        let decoded: FeeStandingQuotePda = borsh::from_slice(&encoded).unwrap();
        assert_eq!(pda, decoded);
    }

    // --- SizedData consistency tests (compare against actual Borsh serialization) ---

    #[test]
    fn test_sized_data_fee_account_leaf_no_signers() {
        let account = FeeAccount {
            bump_seed: 1,
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: None,
            }),
            domain_id: 1,
            min_issued_at: 0,
        };
        assert_eq!(account.size(), borsh::to_vec(&account).unwrap().len());
    }

    #[test]
    fn test_sized_data_fee_account_leaf_with_signers() {
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        signers.insert(H160::random());
        let account = FeeAccount {
            bump_seed: 1,
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: Some(signers),
            }),
            domain_id: 1,
            min_issued_at: 0,
        };
        assert_eq!(account.size(), borsh::to_vec(&account).unwrap().len());
    }

    #[test]
    fn test_sized_data_fee_account_routing() {
        let account = FeeAccount {
            bump_seed: 1,
            owner: None,
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
            domain_id: 1,
            min_issued_at: 0,
        };
        assert_eq!(account.size(), borsh::to_vec(&account).unwrap().len());
    }

    #[test]
    fn test_sized_data_fee_account_cc_with_wildcard_signers() {
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());

        let account = FeeAccount {
            bump_seed: 1,
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: signers,
            }),
            domain_id: 1,
            min_issued_at: -100,
        };
        assert_eq!(account.size(), borsh::to_vec(&account).unwrap().len());
    }

    #[test]
    fn test_require_leaf_signers() {
        // Leaf with None → error
        let fee_data_none = FeeData::Leaf(LeafFeeConfig {
            strategy: FeeDataStrategy::default(),
            signers: None,
        });
        assert!(fee_data_none.require_leaf_signers().is_err());

        // Leaf with Some → ok
        let fee_data_some = FeeData::Leaf(LeafFeeConfig {
            strategy: FeeDataStrategy::default(),
            signers: Some(BTreeSet::new()),
        });
        assert!(fee_data_some.require_leaf_signers().is_ok());

        // Routing → wrong mode error
        let fee_data_routing = FeeData::Routing(RoutingFeeConfig::default());
        assert!(fee_data_routing.require_leaf_signers().is_err());
    }

    #[test]
    fn test_routing_wildcard_signers() {
        let routing = FeeData::Routing(RoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        });
        assert!(routing.routing_wildcard_signers().is_ok());
        assert!(routing.routing_wildcard_signers().unwrap().is_empty());

        // Wrong mode
        let leaf = FeeData::Leaf(LeafFeeConfig::default());
        assert!(leaf.routing_wildcard_signers().is_err());
    }

    #[test]
    fn test_cc_wildcard_signers() {
        let cc = FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        });
        assert!(cc.cc_wildcard_signers().is_ok());
        assert!(cc.cc_wildcard_signers().unwrap().is_empty());

        // Wrong mode
        let routing = FeeData::Routing(RoutingFeeConfig::default());
        assert!(routing.cc_wildcard_signers().is_err());
    }

    #[test]
    fn test_sized_data_route_domain_no_signers() {
        let route = RouteDomain {
            bump_seed: 1,
            fee_data: FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
            signers: None,
        };
        assert_eq!(route.size(), borsh::to_vec(&route).unwrap().len());
    }

    #[test]
    fn test_sized_data_route_domain_with_signers() {
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        signers.insert(H160::random());
        let route = RouteDomain {
            bump_seed: 1,
            fee_data: FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
            signers: Some(signers),
        };
        assert_eq!(route.size(), borsh::to_vec(&route).unwrap().len());
    }

    #[test]
    fn test_sized_data_cc_route_no_signers() {
        let route = CrossCollateralRoute {
            bump_seed: 1,
            fee_data: FeeDataStrategy::Progressive(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
            signers: None,
        };
        assert_eq!(route.size(), borsh::to_vec(&route).unwrap().len());
    }

    #[test]
    fn test_sized_data_cc_route_with_signers() {
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        let route = CrossCollateralRoute {
            bump_seed: 1,
            fee_data: FeeDataStrategy::Progressive(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
            signers: Some(signers),
        };
        assert_eq!(route.size(), borsh::to_vec(&route).unwrap().len());
    }

    #[test]
    fn test_sized_data_transient_quote() {
        let quote = TransientQuote {
            bump_seed: 1,
            payer: Pubkey::new_unique(),
            scoped_salt: H256::random(),
            context: vec![0u8; 44],
            data: vec![0u8; 16],
            expiry: 100,
            ..Default::default()
        };
        assert_eq!(quote.size(), borsh::to_vec(&quote).unwrap().len());
    }

    #[test]
    fn test_sized_data_standing_quote_pda_empty() {
        let pda = FeeStandingQuotePda {
            bump_seed: 1,
            quotes: BTreeMap::new(),
        };
        assert_eq!(pda.size(), borsh::to_vec(&pda).unwrap().len());
    }

    #[test]
    fn test_sized_data_standing_quote_pda_with_entries() {
        let mut quotes = BTreeMap::new();
        quotes.insert(
            H256::zero(),
            FeeStandingQuoteValue {
                issued_at: 100,
                expiry: 200,
                fee_data: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 1000,
                    half_amount: 500,
                }),
                ..Default::default()
            },
        );
        let pda = FeeStandingQuotePda {
            bump_seed: 1,
            quotes,
        };
        assert_eq!(pda.size(), borsh::to_vec(&pda).unwrap().len());
    }

    #[test]
    fn test_standing_quote_value_borsh_size() {
        let value = FeeStandingQuoteValue {
            issued_at: 100,
            expiry: 200,
            fee_data: FeeDataStrategy::Linear(FeeParams {
                max_fee: 1000,
                half_amount: 500,
            }),
            ..Default::default()
        };
        assert_eq!(
            SizedData::size(&value),
            borsh::to_vec(&value).unwrap().len()
        );
    }

    #[test]
    fn test_fee_data_sized_data() {
        for variant in [
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 1,
                    half_amount: 2,
                }),
                signers: None,
            }),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        ] {
            assert_eq!(
                SizedData::size(&variant),
                borsh::to_vec(&variant).unwrap().len()
            );
        }
    }

    // --- Wildcard constants ---

    #[test]
    fn test_wildcard_constants() {
        assert_eq!(WILDCARD_RECIPIENT.as_bytes(), &[0xFF; 32]);
        assert_eq!(WILDCARD_DOMAIN, u32::MAX);
        // DEFAULT_ROUTER = keccak256("RoutingFee.DEFAULT_ROUTER"), matching EVM.
        // Recompute the hash so a bad precomputed constant fails the test.
        let expected =
            H256::from_slice(solana_program::keccak::hash(b"RoutingFee.DEFAULT_ROUTER").as_ref());
        assert_eq!(DEFAULT_ROUTER, expected);
        assert_ne!(DEFAULT_ROUTER, WILDCARD_RECIPIENT);
    }

    // --- Access control ---

    #[test]
    fn test_fee_account_access_control() {
        let owner = Pubkey::new_unique();
        let mut account = FeeAccount {
            owner: Some(owner),
            ..Default::default()
        };
        assert_eq!(account.owner(), Some(&owner));

        let new_owner = Pubkey::new_unique();
        account.set_owner(Some(new_owner)).unwrap();
        assert_eq!(account.owner(), Some(&new_owner));

        account.set_owner(None).unwrap();
        assert_eq!(account.owner(), None);
    }
}
