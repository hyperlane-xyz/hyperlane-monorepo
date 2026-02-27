use account_utils::{AccountData, DiscriminatorData, DiscriminatorPrefixed, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// Top-level fee account, wrapped in AccountData with discriminator prefix.
pub type FeeAccountData = AccountData<DiscriminatorPrefixed<FeeAccount>>;

/// Partial fee account header, wrapped in AccountData with discriminator prefix.
/// Borsh deserialization reads only the header fields and ignores trailing
/// bytes (fee_data), so this can be fetched from a full FeeAccount's raw data.
/// Uses the same discriminator as FeeAccount so partial reads work correctly.
pub type FeeAccountHeaderData = AccountData<DiscriminatorPrefixed<FeeAccountHeader>>;

/// Header fields shared between the full FeeAccount and partial cross-program reads.
///
/// The warp route reads only the header (bump, owner, beneficiary) from
/// the fee account to determine where to send fees, without needing to
/// know or deserialize the FeeData variant.
///
/// Borsh serializes nested structs field-by-field, so embedding this inside
/// FeeAccount produces the same byte layout as a flat struct. The header
/// prefix `(bump, owner, beneficiary)` is stable — new fields added after
/// `fee_data` in FeeAccount will not break header reads.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct FeeAccountHeader {
    /// PDA bump seed.
    pub bump: u8,
    /// Access control owner. None = immutable.
    pub owner: Option<Pubkey>,
    /// The wallet address that receives collected fees.
    pub beneficiary: Pubkey,
}

/// The fee account, containing fee type + parameters.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct FeeAccount {
    /// Header fields (bump, owner, beneficiary).
    pub header: FeeAccountHeader,
    /// The fee configuration data.
    pub fee_data: FeeData,
}

/// FeeAccount and FeeAccountHeader share the same discriminator so that
/// partial header reads from a full FeeAccount's raw data work correctly.
const FEE_ACCOUNT_DISCRIMINATOR: [u8; 8] = *b"FEE_ACCT";

impl DiscriminatorData for FeeAccount {
    const DISCRIMINATOR: [u8; 8] = FEE_ACCOUNT_DISCRIMINATOR;
}

impl DiscriminatorData for FeeAccountHeader {
    const DISCRIMINATOR: [u8; 8] = FEE_ACCOUNT_DISCRIMINATOR;
}

impl SizedData for FeeAccount {
    fn size(&self) -> usize {
        // bump
        std::mem::size_of::<u8>()
        // owner: Option<Pubkey>
        + 1 + 32
        // beneficiary: Pubkey
        + 32
        // fee_data
        + self.fee_data.size()
    }
}

/// Per-domain route PDA for RoutingFee, wrapped in AccountData with discriminator prefix.
pub type RouteDomainData = AccountData<DiscriminatorPrefixed<RouteDomain>>;

impl DiscriminatorData for RouteDomain {
    const DISCRIMINATOR: [u8; 8] = *b"ROUTEDOM";
}

/// A per-domain route with inlined fee parameters.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct RouteDomain {
    /// PDA bump seed.
    pub bump: u8,
    /// The fee configuration data for this domain.
    pub fee_data: FeeData,
}

impl SizedData for RouteDomain {
    fn size(&self) -> usize {
        // bump
        std::mem::size_of::<u8>()
        // fee_data
        + self.fee_data.size()
    }
}

/// Fee type discriminant + parameters.
///
/// Each variant implements a different fee curve mapping transfer amount to fee.
/// All fee variants are capped at `max_fee` and use `half_amount` as a scaling
/// parameter (the transfer amount at which the fee equals half of `max_fee`).
///
/// Fee is always rounded down due to integer division.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub enum FeeData {
    /// Linear fee: fee increases linearly with transfer amount, capped at `max_fee`.
    ///
    /// Formula: `fee = min(max_fee, amount * max_fee / (2 * half_amount))`
    ///
    /// - `max_fee`: Maximum fee (in token units) that can be charged.
    /// - `half_amount`: Transfer amount at which the fee equals half of `max_fee`.
    ///
    /// Example: max_fee=10, half_amount=1000
    ///   amount=1000 -> fee=5, amount=2000 -> fee=10 (capped), amount=500 -> fee=2
    Linear { max_fee: u64, half_amount: u64 },
    /// Regressive fee: fee percentage decreases as transfer amount grows.
    /// Approaches `max_fee` asymptotically but never reaches it.
    ///
    /// Formula: `fee = max_fee * amount / (half_amount + amount)`
    ///
    /// - `max_fee`: Asymptotic upper bound of the fee.
    /// - `half_amount`: Transfer amount at which the fee equals half of `max_fee`.
    ///
    /// Example: max_fee=10, half_amount=1000
    ///   amount=1000 -> fee=5, amount=9000 -> fee=9, amount=100 -> fee=0
    Regressive { max_fee: u64, half_amount: u64 },
    /// Progressive fee: fee percentage increases with transfer amount (S-curve).
    /// Small transfers pay near-zero fees; large transfers approach `max_fee`.
    ///
    /// Formula: `fee = max_fee * amount^2 / (half_amount^2 + amount^2)`
    ///
    /// - `max_fee`: Asymptotic upper bound of the fee.
    /// - `half_amount`: Transfer amount at which the fee equals half of `max_fee`.
    ///
    /// Example: max_fee=10, half_amount=1000
    ///   amount=1000 -> fee=5, amount=100 -> fee=0, amount=10000 -> fee=9
    Progressive { max_fee: u64, half_amount: u64 },
    /// Routing fee: per-domain fee parameters stored in route PDAs.
    ///
    /// The routing fee account itself holds no fee parameters. Instead, it
    /// maintains per-domain route PDAs that each inline a FeeData variant
    /// (Linear, Regressive, or Progressive).
    ///
    /// If no route is set for a domain, the fee is 0.
    Routing,
}

impl Default for FeeData {
    fn default() -> Self {
        FeeData::Linear {
            max_fee: 0,
            half_amount: 0,
        }
    }
}

impl SizedData for FeeData {
    fn size(&self) -> usize {
        // Borsh enum discriminant (1 byte)
        1 + match self {
            FeeData::Linear { .. } | FeeData::Regressive { .. } | FeeData::Progressive { .. } => {
                // max_fee + half_amount
                std::mem::size_of::<u64>() + std::mem::size_of::<u64>()
            }
            FeeData::Routing => 0,
        }
    }
}
