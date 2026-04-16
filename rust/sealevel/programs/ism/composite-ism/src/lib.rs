pub mod account_metas;
pub mod accounts;
pub mod error;
pub mod instruction;
pub mod metadata;
pub mod metadata_spec;
pub mod processor;
pub mod rate_limit;
pub mod verify;

use hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS;

/// PDA seeds for the storage account.
///
/// Uses VERIFY_ACCOUNT_METAS_PDA_SEEDS so the relayer's simulation call
/// automatically finds the storage PDA without any ISM-specific knowledge.
#[macro_export]
macro_rules! storage_pda_seeds {
    () => {{
        hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS
    }};

    ($bump_seed:expr) => {
        &$crate::storage_pda_seeds_with_bump(&[$bump_seed])
    };
}

/// Returns the storage PDA seeds with a bump appended.
///
/// Extends [`VERIFY_ACCOUNT_METAS_PDA_SEEDS`] with the given bump slice without
/// hardcoding the individual seed strings.
pub fn storage_pda_seeds_with_bump(bump: &[u8]) -> [&[u8]; 6] {
    let mut seeds = [b"" as &[u8]; 6];
    seeds[..5].copy_from_slice(VERIFY_ACCOUNT_METAS_PDA_SEEDS);
    seeds[5] = bump;
    seeds
}

pub use processor::process_instruction;
