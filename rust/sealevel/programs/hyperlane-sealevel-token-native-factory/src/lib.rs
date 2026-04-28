//! Factory program for native (SOL) Hyperlane warp routes.
//!
//! Deploys once; each warp route is a PDA created via `CreateRoute`.

#![allow(unexpected_cfgs)]
#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod plugin;
pub mod processor;
