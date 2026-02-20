use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// Top-level fee account, wrapped in AccountData for (de)serialization.
pub type FeeAccountData = AccountData<FeeAccount>;

/// The fee account, containing fee type + parameters.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct FeeAccount {
    /// PDA bump seed.
    pub bump: u8,
    /// Access control owner. None = immutable.
    pub owner: Option<Pubkey>,
    /// The fee configuration data.
    pub fee_data: FeeData,
}

impl SizedData for FeeAccount {
    fn size(&self) -> usize {
        // bump
        std::mem::size_of::<u8>()
        // owner: Option<Pubkey>
        + 1 + 32
        // fee_data
        + self.fee_data.size()
    }
}

/// Per-domain route PDA for RoutingFee, wrapped in AccountData.
pub type RouteDomainData = AccountData<RouteDomain>;

/// A per-domain route that points to a delegated fee account.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct RouteDomain {
    /// PDA bump seed.
    pub bump: u8,
    /// The delegated fee account pubkey.
    pub fee_account: Pubkey,
}

impl SizedData for RouteDomain {
    fn size(&self) -> usize {
        // bump
        std::mem::size_of::<u8>()
        // fee_account
        + 32
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
    /// Routing fee: delegates to per-domain fee accounts via PDAs.
    ///
    /// The routing fee account itself holds no fee parameters. Instead, it
    /// maintains per-domain route PDAs that each point to a delegated fee
    /// account (which can be any other FeeData variant, including another
    /// Routing account for multi-level delegation).
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
