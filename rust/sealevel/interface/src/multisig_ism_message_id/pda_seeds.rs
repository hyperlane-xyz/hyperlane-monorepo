//! PDA seeds for the MultisigIsmMessageId program.

/// PDA seeds relating to the access control PDA account.
#[macro_export]
macro_rules! access_control_pda_seeds {
    () => {{
        &[b"multisig_ism_message_id", b"-", b"access_control"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"multisig_ism_message_id",
            b"-",
            b"access_control",
            &[$bump_seed],
        ]
    }};
}

/// PDA seeds relating to a domain data PDA account.
/// A distinct account exists for each domain.
#[macro_export]
macro_rules! domain_data_pda_seeds {
    ($domain:expr) => {{
        &[
            b"multisig_ism_message_id",
            b"-",
            &$domain.to_le_bytes(),
            b"-",
            b"domain_data",
        ]
    }};

    ($domain:expr, $bump_seed:expr) => {{
        &[
            b"multisig_ism_message_id",
            b"-",
            &$domain.to_le_bytes(),
            b"-",
            b"domain_data",
            &[$bump_seed],
        ]
    }};
}
