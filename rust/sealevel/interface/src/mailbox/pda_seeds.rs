//! This file contains the PDA seeds for the Mailbox program.

/// PDA seeds for the Inbox account.
#[macro_export]
macro_rules! mailbox_inbox_pda_seeds {
    () => {{
        &[b"hyperlane", b"-", b"inbox"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane", b"-", b"inbox", &[$bump_seed]]
    }};
}

/// PDA seeds for the Outbox account.
#[macro_export]
macro_rules! mailbox_outbox_pda_seeds {
    () => {{
        &[b"hyperlane", b"-", b"outbox"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane", b"-", b"outbox", &[$bump_seed]]
    }};
}

/// Gets the PDA seeds for a message storage account that's
/// based upon the pubkey of a unique message account.
#[macro_export]
macro_rules! mailbox_dispatched_message_pda_seeds {
    ($unique_message_pubkey:expr) => {{
        &[
            b"hyperlane",
            b"-",
            b"dispatched_message",
            b"-",
            $unique_message_pubkey.as_ref(),
        ]
    }};

    ($unique_message_pubkey:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane",
            b"-",
            b"dispatched_message",
            b"-",
            $unique_message_pubkey.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// The PDA seeds relating to a program's dispatch authority.
#[macro_export]
macro_rules! mailbox_message_dispatch_authority_pda_seeds {
    () => {{
        &[b"hyperlane_dispatcher", b"-", b"dispatch_authority"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_dispatcher",
            b"-",
            b"dispatch_authority",
            &[$bump_seed],
        ]
    }};
}

/// The PDA seeds relating to the Mailbox's process authority for a particular recipient.
#[macro_export]
macro_rules! mailbox_process_authority_pda_seeds {
    ($recipient_pubkey:expr) => {{
        &[
            b"hyperlane",
            b"-",
            b"process_authority",
            b"-",
            $recipient_pubkey.as_ref(),
        ]
    }};

    ($recipient_pubkey:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane",
            b"-",
            b"process_authority",
            b"-",
            $recipient_pubkey.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// The PDA seeds relating to the Mailbox's process authority for a particular recipient.
#[macro_export]
macro_rules! mailbox_processed_message_pda_seeds {
    ($message_id_h256:expr) => {{
        &[
            b"hyperlane",
            b"-",
            b"processed_message",
            b"-",
            $message_id_h256.as_bytes(),
        ]
    }};

    ($message_id_h256:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane",
            b"-",
            b"processed_message",
            b"-",
            $message_id_h256.as_bytes(),
            &[$bump_seed],
        ]
    }};
}
