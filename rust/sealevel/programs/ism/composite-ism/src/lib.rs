pub mod account_metas;
pub mod accounts;
pub mod error;
pub mod instruction;
pub mod metadata;
pub mod metadata_spec;
pub mod multisig_metadata;
pub mod processor;
pub mod rate_limit;
pub mod verify;

/// PDA seeds for the storage account.
///
/// Uses VERIFY_ACCOUNT_METAS_PDA_SEEDS so the relayer's simulation call
/// automatically finds the storage PDA without any ISM-specific knowledge.
#[macro_export]
macro_rules! storage_pda_seeds {
    () => {{
        hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_ism",
            b"-",
            b"verify",
            b"-",
            b"account_metas",
            &[$bump_seed],
        ]
    }};
}

pub use processor::process_instruction;
