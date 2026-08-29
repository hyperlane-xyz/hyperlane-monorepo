use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, HexBinary};
use cw_storage_plus::Item;

#[cw_serde]
pub struct Config {
    pub owner: Addr,
    pub light_client_address: Addr,
    /// 20-byte Ethereum address of DispatchedHook contract on origin chain
    pub dispatched_hook_address: HexBinary,
    /// Origin chain domain ID (e.g. 1 for Mainnet, 17000 for Holesky)
    pub origin_domain: u32,
    /// Storage slot index of the `dispatched` mapping in DispatchedHook.sol (typically 0)
    pub storage_slot_index: u32,
    /// Offchain CCIP-read gateway endpoints
    pub ccip_gateway_urls: Vec<String>,
}

pub const CONFIG: Item<Config> = Item::new("config");
