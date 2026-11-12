//! Interchain Gas Paymaster program interface.

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod pda_seeds;

pub use crate::{
    igp_gas_payment_pda_seeds, igp_pda_seeds, igp_program_data_pda_seeds,
    igp_quote_authority_pda_seeds, igp_standing_quote_pda_seeds, igp_transient_quote_pda_seeds,
    overhead_igp_pda_seeds,
};
