//! ValidatorAnnounce program interface.

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod pda_seeds;

pub use crate::{
    replay_protection_pda_seeds, validator_announce_pda_seeds,
    validator_storage_locations_pda_seeds,
};
