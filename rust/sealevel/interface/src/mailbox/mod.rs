//! Mailbox program interface.

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod pda_seeds;
pub mod protocol_fee;

pub use crate::{
    mailbox_dispatched_message_pda_seeds, mailbox_inbox_pda_seeds,
    mailbox_message_dispatch_authority_pda_seeds, mailbox_outbox_pda_seeds,
    mailbox_process_authority_pda_seeds, mailbox_processed_message_pda_seeds,
};
