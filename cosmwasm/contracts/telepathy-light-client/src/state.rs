use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, HexBinary};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub owner: Addr,
    pub pending_owner: Option<Addr>,
    pub genesis_validators_root: HexBinary,
    pub source_chain_id: u64,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const LATEST_SLOT: Item<u64> = Item::new("latest_slot");
pub const EXECUTION_STATE_ROOTS: Map<u64, HexBinary> = Map::new("execution_state_roots");
pub const HEADER_ROOTS: Map<u64, HexBinary> = Map::new("header_roots");
pub const SYNC_COMMITTEE_ROOTS: Map<u64, HexBinary> = Map::new("sync_committee_roots");
