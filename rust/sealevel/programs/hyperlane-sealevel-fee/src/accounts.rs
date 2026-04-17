//! Fee program account structures.

use std::collections::{BTreeMap, BTreeSet};

use access_control::AccessControl;
use account_utils::{AccountData, DiscriminatorData, DiscriminatorPrefixed, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H160, H256};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::fee_math::FeeDataStrategy;

// --- Discriminators ---

pub const FEE_ACCOUNT_DISCRIMINATOR: [u8; 8] = *b"FEE_ACCT";
pub const ROUTE_DOMAIN_DISCRIMINATOR: [u8; 8] = *b"ROUTEDOM";
pub const CC_ROUTE_DISCRIMINATOR: [u8; 8] = *b"CC_ROUTE";
pub const TRANSIENT_QUOTE_DISCRIMINATOR: [u8; 8] = *b"TRNQUOTE";
pub const STANDING_QUOTE_DISCRIMINATOR: [u8; 8] = *b"STDQUOTE";

// --- Wildcard constants ---

/// Wildcard recipient for standing quotes: matches any end-user destination address.
pub const WILDCARD_RECIPIENT: H256 = H256::repeat_byte(0xFF);

/// Wildcard destination domain for standing quotes: matches any Hyperlane domain ID.
pub const WILDCARD_DOMAIN: u32 = u32::MAX;

/// Default target router for CC routing fallback when no specific (dest, target_router) match.
pub const DEFAULT_ROUTER: H256 = H256::repeat_byte(0xFF);

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

// --- Top-level fee data enum ---

/// Determines how fee resolution works for a fee account.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub enum FeeData {
    /// Leaf fee strategy — directly computes fee from params.
    Leaf(FeeDataStrategy),
    /// Per-domain lookup via RouteDomain PDAs.
    /// Uninitialized domains produce an error (prevents accidental zero fees).
    Routing,
    /// Per-(destination, target_router) lookup for cross-collateral warp routes.
    /// target_router is the remote warp route contract address.
    CrossCollateralRouting,
}

impl Default for FeeData {
    fn default() -> Self {
        Self::Leaf(FeeDataStrategy::default())
    }
}

impl SizedData for FeeData {
    fn size(&self) -> usize {
        // 1 byte for enum variant tag
        1 + match self {
            FeeData::Leaf(strategy) => SizedData::size(strategy),
            FeeData::Routing | FeeData::CrossCollateralRouting => 0,
        }
    }
}

// --- Fee account ---

pub type FeeAccountData = AccountData<DiscriminatorPrefixed<FeeAccount>>;

impl DiscriminatorData for FeeAccount {
    const DISCRIMINATOR: [u8; 8] = FEE_ACCOUNT_DISCRIMINATOR;
}

/// The main fee account, one per warp route.
/// Created via InitFee with a salt-derived PDA.
#[derive(BorshDeserialize, BorshSerialize, Debug, Default, PartialEq)]
pub struct FeeAccount {
    /// PDA bump seed.
    pub bump: u8,
    /// Owner who can modify fee configuration. None = immutable.
    pub owner: Option<Pubkey>,
    /// Beneficiary who receives collected token fees.
    pub beneficiary: Pubkey,
    /// Fee resolution strategy (Leaf, Routing, or CrossCollateralRouting).
    pub fee_data: FeeData,
    /// Hyperlane domain ID of the local chain (used in quote signature verification).
    pub domain_id: u32,
    /// Authorized offchain quote signers (secp256k1 Ethereum addresses).
    pub signers: BTreeSet<H160>,
    /// Emergency revocation threshold: standing quotes with issued_at < min_issued_at are rejected.
    pub min_issued_at: i64,
    /// Set of Hyperlane destination domain IDs that have standing quote PDAs.
    /// Used for offchain PDA discovery.
    pub standing_quote_domains: BTreeSet<u32>,
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

impl SizedData for FeeAccount {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()                                                                   // bump
        + option_pubkey_size(&self.owner)                                                           // owner
        + PUBKEY_SIZE                                                                               // beneficiary
        + SizedData::size(&self.fee_data)                                                             // fee_data
        + std::mem::size_of::<u32>()                                                                // domain_id
        + BORSH_LEN_PREFIX + (self.signers.len() * H160_SIZE)                                       // signers
        + std::mem::size_of::<i64>()                                                                // min_issued_at
        + BORSH_LEN_PREFIX + (self.standing_quote_domains.len() * std::mem::size_of::<u32>())
        // standing_quote_domains
    }
}

// --- Route domain PDA ---

pub type RouteDomainAccount = AccountData<DiscriminatorPrefixed<RouteDomain>>;

impl DiscriminatorData for RouteDomain {
    const DISCRIMINATOR: [u8; 8] = ROUTE_DOMAIN_DISCRIMINATOR;
}

/// Per-destination-domain fee configuration for Routing mode.
/// PDA derived from fee_account + destination domain ID (u32 LE).
#[derive(BorshDeserialize, BorshSerialize, Debug, Default, PartialEq)]
pub struct RouteDomain {
    /// PDA bump seed.
    pub bump: u8,
    /// Fee strategy for this destination domain.
    pub fee_data: FeeDataStrategy,
}

impl SizedData for RouteDomain {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>() + SizedData::size(&self.fee_data)
    }
}

// --- Cross-collateral route PDA ---

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
    pub bump: u8,
    /// Fee strategy for this (destination, target_router) pair.
    pub fee_data: FeeDataStrategy,
}

impl SizedData for CrossCollateralRoute {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>() + SizedData::size(&self.fee_data)
    }
}

// --- Transient quote PDA ---

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
    pub bump: u8,
    /// The payer who created this quote (binding for scoped salt verification).
    pub payer: Pubkey,
    /// keccak256(payer || client_salt) — used as PDA seed for collision prevention.
    pub scoped_salt: H256,
    /// Fee-type-specific context bytes (44B non-CC: dest_domain u32 + recipient H256 + amount u64,
    /// or 76B CC: adds target_router H256).
    pub context: Vec<u8>,
    /// Fee params bytes (16B: max_fee u64 LE + half_amount u64 LE).
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

// --- Standing quote PDA ---

// --- Quote context and data parsing ---

/// Trait for quote context types. Implementations parse from raw bytes
/// and validate against the QuoteFee instruction data.
pub trait QuoteContext: Sized {
    fn try_from_bytes(bytes: &[u8]) -> Result<Self, ProgramError>;
    fn validate(&self, quote_fee: &crate::instruction::QuoteFee) -> Result<(), ProgramError>;
}

/// Quote context for Leaf and Routing fee accounts.
/// Wire format (44 bytes): dest_domain (u32 LE) + recipient (H256) + amount (u64 LE).
#[derive(Debug, PartialEq)]
pub struct FeeQuoteContext {
    pub destination_domain: u32,
    pub recipient: H256,
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
            return Err(crate::error::Error::TransientContextMismatch.into());
        }
        Ok(())
    }
}

/// Quote context for CrossCollateralRouting fee accounts.
/// Wire format (76 bytes): dest_domain (u32 LE) + recipient (H256) + amount (u64 LE) + target_router (H256).
#[derive(Debug, PartialEq)]
pub struct CcFeeQuoteContext {
    pub destination_domain: u32,
    pub recipient: H256,
    pub amount: u64,
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
            return Err(crate::error::Error::TransientContextMismatch.into());
        }
        Ok(())
    }
}

/// Parsed quote data containing fee curve parameters.
/// Wire format: max_fee (u64 LE, 8 bytes) + half_amount (u64 LE, 8 bytes).
#[derive(Debug, Default, PartialEq)]
pub struct FeeQuoteData {
    pub max_fee: u64,
    pub half_amount: u64,
}

impl SizedData for FeeQuoteData {
    fn size(&self) -> usize {
        std::mem::size_of::<u64>() // max_fee
        + std::mem::size_of::<u64>() // half_amount
    }
}

impl TryFrom<&[u8]> for FeeQuoteData {
    type Error = ProgramError;

    fn try_from(bytes: &[u8]) -> Result<Self, Self::Error> {
        if bytes.len() != SizedData::size(&FeeQuoteData::default()) {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            max_fee: u64::from_le_bytes(
                bytes[0..8]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            ),
            half_amount: u64::from_le_bytes(
                bytes[8..16]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            ),
        })
    }
}

// --- Standing quote PDA ---

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
    pub bump: u8,
    /// Standing quotes keyed by recipient address on the destination chain (H256).
    /// WILDCARD_RECIPIENT ([0xFF; 32]) matches any recipient.
    pub quotes: BTreeMap<H256, FeeStandingQuoteValue>,
}

impl SizedData for FeeStandingQuotePda {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()                                                                       // bump
        + BORSH_LEN_PREFIX + (self.quotes.len() * (H256_SIZE + SizedData::size(&FeeStandingQuoteValue::default())))
        // quotes
    }
}

/// A standing quote value for a specific recipient on a specific destination domain.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Default, PartialEq)]
pub struct FeeStandingQuoteValue {
    /// When the quote was issued (unix timestamp).
    pub issued_at: i64,
    /// When the quote expires (unix timestamp). Must be > issued_at for standing quotes.
    pub expiry: i64,
    /// Maximum fee parameter for the fee curve.
    pub max_fee: u64,
    /// Half amount parameter — transfer amount at which fee = max_fee / 2.
    pub half_amount: u64,
}

impl SizedData for FeeStandingQuoteValue {
    fn size(&self) -> usize {
        std::mem::size_of::<i64>()  // issued_at
        + std::mem::size_of::<i64>() // expiry
        + std::mem::size_of::<u64>() // max_fee
        + std::mem::size_of::<u64>() // half_amount
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
            FeeData::Leaf(FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            })),
            FeeData::Routing,
            FeeData::CrossCollateralRouting,
        ] {
            let encoded = borsh::to_vec(&variant).unwrap();
            let decoded: FeeData = borsh::from_slice(&encoded).unwrap();
            assert_eq!(variant, decoded);
        }
    }

    #[test]
    fn test_fee_account_borsh_roundtrip() {
        let account = FeeAccount {
            bump: 255,
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::Routing,
            domain_id: 42,
            signers: BTreeSet::new(),
            min_issued_at: 0,
            standing_quote_domains: BTreeSet::new(),
        };
        let encoded = borsh::to_vec(&account).unwrap();
        let decoded: FeeAccount = borsh::from_slice(&encoded).unwrap();
        assert_eq!(account, decoded);
    }

    #[test]
    fn test_route_domain_borsh_roundtrip() {
        let route = RouteDomain {
            bump: 1,
            fee_data: FeeDataStrategy::Regressive(FeeParams {
                max_fee: 500,
                half_amount: 250,
            }),
        };
        let encoded = borsh::to_vec(&route).unwrap();
        let decoded: RouteDomain = borsh::from_slice(&encoded).unwrap();
        assert_eq!(route, decoded);
    }

    #[test]
    fn test_cc_route_borsh_roundtrip() {
        let route = CrossCollateralRoute {
            bump: 2,
            fee_data: FeeDataStrategy::Progressive(FeeParams {
                max_fee: 1000,
                half_amount: 500,
            }),
        };
        let encoded = borsh::to_vec(&route).unwrap();
        let decoded: CrossCollateralRoute = borsh::from_slice(&encoded).unwrap();
        assert_eq!(route, decoded);
    }

    #[test]
    fn test_transient_quote_borsh_roundtrip() {
        let quote = TransientQuote {
            bump: 3,
            payer: Pubkey::new_unique(),
            scoped_salt: H256::random(),
            context: vec![1, 2, 3, 4],
            data: vec![5, 6, 7, 8],
            expiry: 1234567890,
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
                max_fee: 1000,
                half_amount: 500,
            },
        );
        quotes.insert(
            WILDCARD_RECIPIENT,
            FeeStandingQuoteValue {
                issued_at: 100,
                expiry: 300,
                max_fee: 2000,
                half_amount: 1000,
            },
        );
        let pda = FeeStandingQuotePda { bump: 4, quotes };
        let encoded = borsh::to_vec(&pda).unwrap();
        let decoded: FeeStandingQuotePda = borsh::from_slice(&encoded).unwrap();
        assert_eq!(pda, decoded);
    }

    // --- SizedData consistency tests (compare against actual Borsh serialization) ---

    #[test]
    fn test_sized_data_fee_account_leaf() {
        let account = FeeAccount {
            bump: 1,
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::Leaf(FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            })),
            domain_id: 1,
            signers: BTreeSet::new(),
            min_issued_at: 0,
            standing_quote_domains: BTreeSet::new(),
        };
        assert_eq!(account.size(), borsh::to_vec(&account).unwrap().len());
    }

    #[test]
    fn test_sized_data_fee_account_routing() {
        let account = FeeAccount {
            bump: 1,
            owner: None,
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::Routing,
            domain_id: 1,
            signers: BTreeSet::new(),
            min_issued_at: 0,
            standing_quote_domains: BTreeSet::new(),
        };
        assert_eq!(account.size(), borsh::to_vec(&account).unwrap().len());
    }

    #[test]
    fn test_sized_data_fee_account_with_signers_and_domains() {
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        signers.insert(H160::random());
        let mut domains = BTreeSet::new();
        domains.insert(1u32);
        domains.insert(42u32);
        domains.insert(1000u32);

        let account = FeeAccount {
            bump: 1,
            owner: Some(Pubkey::new_unique()),
            beneficiary: Pubkey::new_unique(),
            fee_data: FeeData::CrossCollateralRouting,
            domain_id: 1,
            signers,
            min_issued_at: -100,
            standing_quote_domains: domains,
        };
        assert_eq!(account.size(), borsh::to_vec(&account).unwrap().len());
    }

    #[test]
    fn test_sized_data_route_domain() {
        let route = RouteDomain {
            bump: 1,
            fee_data: FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        };
        assert_eq!(route.size(), borsh::to_vec(&route).unwrap().len());
    }

    #[test]
    fn test_sized_data_cc_route() {
        let route = CrossCollateralRoute {
            bump: 1,
            fee_data: FeeDataStrategy::Progressive(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        };
        assert_eq!(route.size(), borsh::to_vec(&route).unwrap().len());
    }

    #[test]
    fn test_sized_data_transient_quote() {
        let quote = TransientQuote {
            bump: 1,
            payer: Pubkey::new_unique(),
            scoped_salt: H256::random(),
            context: vec![0u8; 44],
            data: vec![0u8; 16],
            expiry: 100,
        };
        assert_eq!(quote.size(), borsh::to_vec(&quote).unwrap().len());
    }

    #[test]
    fn test_sized_data_standing_quote_pda_empty() {
        let pda = FeeStandingQuotePda {
            bump: 1,
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
                max_fee: 1000,
                half_amount: 500,
            },
        );
        let pda = FeeStandingQuotePda { bump: 1, quotes };
        assert_eq!(pda.size(), borsh::to_vec(&pda).unwrap().len());
    }

    #[test]
    fn test_standing_quote_value_borsh_size() {
        let value = FeeStandingQuoteValue {
            issued_at: 100,
            expiry: 200,
            max_fee: 1000,
            half_amount: 500,
        };
        assert_eq!(
            SizedData::size(&value),
            borsh::to_vec(&value).unwrap().len()
        );
    }

    #[test]
    fn test_fee_data_sized_data() {
        for variant in [
            FeeData::Leaf(FeeDataStrategy::Linear(FeeParams {
                max_fee: 1,
                half_amount: 2,
            })),
            FeeData::Routing,
            FeeData::CrossCollateralRouting,
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
        assert_eq!(DEFAULT_ROUTER.as_bytes(), &[0xFF; 32]);
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
