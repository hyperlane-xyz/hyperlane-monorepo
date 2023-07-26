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
