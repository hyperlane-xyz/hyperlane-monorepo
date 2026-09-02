use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, HexBinary};
use cw_storage_plus::Item;

#[cw_serde]
pub struct Config {
    pub owner: Addr,
    pub pending_owner: Option<Addr>,
    pub light_client: Addr,
    pub origin_mailbox: HexBinary, // 20 bytes EVM address
    pub origin_domain: u32,        // Ethereum domain ID (e.g. 1)
    pub urls: Vec<String>,         // CCIP-read gateway URLs
}

pub const CONFIG: Item<Config> = Item::new("config");
