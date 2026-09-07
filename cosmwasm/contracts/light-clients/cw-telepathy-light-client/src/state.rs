use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, HexBinary};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub owner: Addr,
    pub sync_committee_poseidon: HexBinary,
    pub head_slot: u64,
}

pub const CONFIG: Item<Config> = Item::new("config");

/// Mapping of beacon chain slot -> 32-byte execution state root
pub const EXECUTION_STATE_ROOTS: Map<u64, HexBinary> = Map::new("execution_state_roots");
