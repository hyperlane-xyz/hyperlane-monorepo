/// PDA seeds for the fee account: ["hyperlane_fee", "-", "fee", "-", salt]
#[macro_export]
macro_rules! fee_pda_seeds {
    ($salt:expr) => {{
        &[b"hyperlane_fee", b"-", b"fee", b"-", $salt.as_ref()]
    }};

    ($salt:expr, $bump:expr) => {{
        &[
            b"hyperlane_fee",
            b"-",
            b"fee",
            b"-",
            $salt.as_ref(),
            &[$bump],
        ]
    }};
}

/// PDA seeds for the route domain: ["hyperlane_fee", "-", "route", "-", fee_key, "-", &domain.to_le_bytes()]
#[macro_export]
macro_rules! fee_route_pda_seeds {
    ($fee_key:expr, $domain:expr) => {{
        &[
            b"hyperlane_fee",
            b"-",
            b"route",
            b"-",
            $fee_key.as_ref(),
            b"-",
            &$domain.to_le_bytes(),
        ]
    }};

    ($fee_key:expr, $domain:expr, $bump:expr) => {{
        &[
            b"hyperlane_fee",
            b"-",
            b"route",
            b"-",
            $fee_key.as_ref(),
            b"-",
            &$domain.to_le_bytes(),
            &[$bump],
        ]
    }};
}
