//! Fee program PDA seeds.

/// PDA seeds for a fee account.
/// Seeds: ["hyperlane_fee", "-", "fee", "-", salt]
#[macro_export]
macro_rules! fee_account_pda_seeds {
    ($salt:expr) => {{
        &[b"hyperlane_fee", b"-", b"fee", b"-", $salt.as_ref()]
    }};

    ($salt:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_fee",
            b"-",
            b"fee",
            b"-",
            $salt.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// PDA seeds for a route domain account.
/// Seeds: ["hyperlane_fee", "-", "route", "-", fee_account, "-", domain_le]
#[macro_export]
macro_rules! route_domain_pda_seeds {
    ($fee_account:expr, $domain_le:expr) => {{
        &[
            b"hyperlane_fee",
            b"-",
            b"route",
            b"-",
            $fee_account.as_ref(),
            b"-",
            $domain_le,
        ]
    }};

    ($fee_account:expr, $domain_le:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_fee",
            b"-",
            b"route",
            b"-",
            $fee_account.as_ref(),
            b"-",
            $domain_le,
            &[$bump_seed],
        ]
    }};
}

/// PDA seeds for a cross-collateral route account.
/// Seeds: ["cc_fee_route", fee_account, dest_le, target_router]
#[macro_export]
macro_rules! cc_route_pda_seeds {
    ($fee_account:expr, $dest_le:expr, $target_router:expr) => {{
        &[
            b"cc_fee_route",
            $fee_account.as_ref(),
            $dest_le,
            $target_router.as_ref(),
        ]
    }};

    ($fee_account:expr, $dest_le:expr, $target_router:expr, $bump_seed:expr) => {{
        &[
            b"cc_fee_route",
            $fee_account.as_ref(),
            $dest_le,
            $target_router.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// PDA seeds for a transient quote account.
/// Seeds: ["transient_quote", fee_account, scoped_salt]
#[macro_export]
macro_rules! transient_quote_pda_seeds {
    ($fee_account:expr, $scoped_salt:expr) => {{
        &[
            b"transient_quote",
            $fee_account.as_ref(),
            $scoped_salt.as_ref(),
        ]
    }};

    ($fee_account:expr, $scoped_salt:expr, $bump_seed:expr) => {{
        &[
            b"transient_quote",
            $fee_account.as_ref(),
            $scoped_salt.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// PDA seeds for a standing quote domain account.
/// Seeds: ["fee_quotes", fee_account, domain_le]
/// Wildcard domain uses u32::MAX LE bytes.
#[macro_export]
macro_rules! fee_standing_quote_pda_seeds {
    ($fee_account:expr, $domain_le:expr) => {{
        &[b"fee_quotes", $fee_account.as_ref(), $domain_le]
    }};

    ($fee_account:expr, $domain_le:expr, $bump_seed:expr) => {{
        &[
            b"fee_quotes",
            $fee_account.as_ref(),
            $domain_le,
            &[$bump_seed],
        ]
    }};
}
