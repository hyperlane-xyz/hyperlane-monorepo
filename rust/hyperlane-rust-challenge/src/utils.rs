use ethers::{
    providers::{Http, Provider},
    types::Address,
};

use std::sync::OnceLock;

pub static PROVIDER: OnceLock<Provider<Http>> = OnceLock::new();
pub static MAILBOX: OnceLock<Address> = OnceLock::new();

