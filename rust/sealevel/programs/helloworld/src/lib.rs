//! A HelloWorld program that sends and receives messages to & from other routers.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]
#![allow(unexpected_cfgs)]

use solana_program::declare_id;

// Placeholder program ID - should be updated with actual deployed program address
declare_id!("6eG2D5T3Gcenx6TNJr2u9tCPCpANpNdUMSLatAhYHYzV");

pub mod accounts;
pub mod instruction;
pub mod processor;
pub mod types;
