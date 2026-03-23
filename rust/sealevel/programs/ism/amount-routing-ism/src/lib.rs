//! An Amount Routing ISM that routes message verification to one of two
//! sub-ISMs based on the warp-route token transfer amount.
//!
//! Routes to `lower_ism` if amount < threshold, else `upper_ism`.

#![allow(unexpected_cfgs)]
#![deny(warnings)]
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod processor;
