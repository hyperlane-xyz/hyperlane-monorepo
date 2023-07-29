//! Program-specific PDA seeds.

/// PDA seeds for the ValidatorAnnounce account.
#[macro_export]
macro_rules! validator_announce_pda_seeds {
    () => {{
        &[b"hyperlane_validator_announce", b"-", b"validator_announce"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_validator_announce",
            b"-",
            b"validator_announce",
            &[$bump_seed],
        ]
    }};
}

/// PDA seeds for validator-specific ValidatorStorageLocations accounts.
#[macro_export]
macro_rules! validator_storage_locations_pda_seeds {
    ($validator_h160:expr) => {{
        &[
            b"hyperlane_validator_announce",
            b"-",
            b"storage_locations",
            b"-",
            $validator_h160.as_bytes(),
        ]
    }};

    ($validator_h160:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_validator_announce",
            b"-",
            b"storage_locations",
            b"-",
            $validator_h160.as_bytes(),
            &[$bump_seed],
        ]
    }};
}

/// PDA seeds for replay protection accounts.
#[macro_export]
macro_rules! replay_protection_pda_seeds {
    ($replay_id_bytes:expr) => {{
        &[
            b"hyperlane_validator_announce",
            b"-",
            b"replay_protection",
            b"-",
            &$replay_id_bytes[..],
        ]
    }};

    ($replay_id_bytes:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_validator_announce",
            b"-",
            b"replay_protection",
            b"-",
            &$replay_id_bytes[..],
            &[$bump_seed],
        ]
    }};
}
