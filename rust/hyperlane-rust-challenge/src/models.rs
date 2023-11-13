use ethers::{
    prelude::abigen,
    types::{ H160, H256},
};
use serde::{Deserialize, Serialize};

// https://docs.hyperlane.xyz/docs/resources/addresses#mailbox-1
abigen!(Mailbox, "./hyperlane-rust-challenge/abis/mailbox.json");

// https://docs.hyperlane.xyz/docs/resources/addresses#interchaingaspaymaster-1
abigen!(
    Paymaster,
    "./hyperlane-rust-challenge/abis/interchainGasPaymaster.json"
);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Dispatch {
    pub id: H256,
    pub origin: u32,
    pub sender: H160,
    pub destination: u32,
    pub receiver: H160,
    pub message: String,
}
