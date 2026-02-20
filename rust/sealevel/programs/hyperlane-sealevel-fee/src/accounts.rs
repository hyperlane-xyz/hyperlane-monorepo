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
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub enum FeeData {
    /// Linear fee: fee = min(max_fee, amount * max_fee / (2 * half_amount))
    Linear {
        max_fee: u64,
        half_amount: u64,
    },
    /// Regressive fee: fee = max_fee * amount / (half_amount + amount)
    Regressive {
        max_fee: u64,
        half_amount: u64,
    },
    /// Progressive fee: fee = max_fee * amount^2 / (half_amount^2 + amount^2)
    Progressive {
        max_fee: u64,
        half_amount: u64,
    },
    /// Routing fee: delegates to per-domain fee accounts via PDAs.
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
