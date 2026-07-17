//! Program PDA seeds.

/// Gets the PDA seeds for the singleton program data account.
#[macro_export]
macro_rules! cctp_hook_program_data_pda_seeds {
    () => {{
        &[b"hyperlane_cctp_hook", b"-", b"program_data"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_cctp_hook", b"-", b"program_data", &[$bump_seed]]
    }};
}

/// Gets the PDA seeds for a per-destination-domain remote config account.
#[macro_export]
macro_rules! cctp_hook_remote_config_pda_seeds {
    ($destination_domain_le:expr) => {{
        &[
            b"hyperlane_cctp_hook",
            b"-",
            b"remote_config",
            b"-",
            $destination_domain_le,
        ]
    }};

    ($destination_domain_le:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_cctp_hook",
            b"-",
            b"remote_config",
            b"-",
            $destination_domain_le,
            &[$bump_seed],
        ]
    }};
}

/// Gets the PDA seeds for this program's CCTP `sender_authority`.
///
/// Circle's `MessageTransmitterV2::send_message` requires this exact PDA
/// (seeds `[b"sender_authority"]`, derived under the *calling* program's own
/// ID) as a signer — only this program can produce that signature via
/// `invoke_signed`, so Circle's message records this program as the CCTP
/// `sender`.
#[macro_export]
macro_rules! cctp_hook_sender_authority_pda_seeds {
    () => {{
        &[b"sender_authority"]
    }};

    ($bump_seed:expr) => {{
        &[b"sender_authority", &[$bump_seed]]
    }};
}
