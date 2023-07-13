/// Gets the PDA seeds for a message storage account that's
/// based upon the pubkey of a unique message account.
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
