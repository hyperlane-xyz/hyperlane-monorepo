//! Program PDA seeds.

/// Gets the PDA seeds for the singleton program data.
#[macro_export]
macro_rules! igp_program_data_pda_seeds {
    () => {{
        &[b"hyperlane_igp", b"-", b"program_data"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_igp", b"-", b"program_data", &[$bump_seed]]
    }};
}

/// Gets the PDA seeds for an IGP account.
#[macro_export]
macro_rules! igp_pda_seeds {
    ($salt:expr) => {{
        &[b"hyperlane_igp", b"-", b"igp", b"-", $salt.as_ref()]
    }};

    ($salt:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"igp",
            b"-",
            $salt.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// Gets the PDA seeds for an Overhead IGP account.
#[macro_export]
macro_rules! overhead_igp_pda_seeds {
    ($salt:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"overhead_igp",
            b"-",
            $salt.as_ref(),
        ]
    }};

    ($salt:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"overhead_igp",
            b"-",
            $salt.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// Gets the PDA seeds for an IGP standing quote account.
/// One PDA per (igp_account, fee_token_mint, destination_domain, sender) combination.
#[macro_export]
macro_rules! igp_standing_quote_pda_seeds {
    ($igp_account:expr, $fee_token_mint:expr, $dest_domain_le:expr, $sender:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"standing_quote",
            b"-",
            $igp_account.as_ref(),
            b"-",
            $fee_token_mint.as_ref(),
            b"-",
            $dest_domain_le,
            b"-",
            $sender.as_ref(),
        ]
    }};

    ($igp_account:expr, $fee_token_mint:expr, $dest_domain_le:expr, $sender:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"standing_quote",
            b"-",
            $igp_account.as_ref(),
            b"-",
            $fee_token_mint.as_ref(),
            b"-",
            $dest_domain_le,
            b"-",
            $sender.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// Gets the PDA seeds for an IGP transient quote account.
/// One PDA per (igp_account, scoped_salt) combination.
#[macro_export]
macro_rules! igp_transient_quote_pda_seeds {
    ($igp_account:expr, $scoped_salt:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"transient_quote",
            b"-",
            $igp_account.as_ref(),
            b"-",
            $scoped_salt.as_ref(),
        ]
    }};

    ($igp_account:expr, $scoped_salt:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"transient_quote",
            b"-",
            $igp_account.as_ref(),
            b"-",
            $scoped_salt.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// Gets the PDA seeds for the IGP quote authority.
///
/// Derived under the warp route program id and used to authorize quoted IGP
/// gas payments. Distinct from the mailbox dispatch authority
/// (`["hyperlane_dispatcher", "-", "dispatch_authority"]`) so a malicious
/// configured IGP cannot replay the forwarded signer into a Mailbox dispatch.
#[macro_export]
macro_rules! igp_quote_authority_pda_seeds {
    () => {{
        &[b"hyperlane_dispatcher", b"-", b"igp_quote_authority"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_dispatcher",
            b"-",
            b"igp_quote_authority",
            &[$bump_seed],
        ]
    }};
}

/// Gets the PDA seeds for an IGP gas payment account that's based upon
/// the pubkey of a unique message account for uniqueness.
#[macro_export]
macro_rules! igp_gas_payment_pda_seeds {
    ($unique_gas_payment_pubkey:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"gas_payment",
            b"-",
            $unique_gas_payment_pubkey.as_ref(),
        ]
    }};

    ($unique_gas_payment_pubkey:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_igp",
            b"-",
            b"gas_payment",
            b"-",
            $unique_gas_payment_pubkey.as_ref(),
            &[$bump_seed],
        ]
    }};
}
