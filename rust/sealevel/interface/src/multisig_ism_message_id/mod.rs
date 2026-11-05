//! MultisigIsmMessageId program interface.

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod pda_seeds;

pub use crate::{access_control_pda_seeds, domain_data_pda_seeds};
