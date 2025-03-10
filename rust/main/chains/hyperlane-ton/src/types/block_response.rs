use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct BlockResponse {
    pub blocks: Vec<Block>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Block {
    pub after_merge: bool,
    pub after_split: bool,
    pub before_split: bool,
    pub created_by: String,
    pub end_lt: String,
    pub file_hash: String,
    pub flags: i32,
    pub gen_catchain_seqno: i32,
    pub gen_utime: String,
    pub global_id: i32,
    pub key_block: bool,
    pub master_ref_seqno: i32,
    pub masterchain_block_ref: MasterChainBlockRef,
    pub min_ref_mc_seqno: i32,
    pub prev_blocks: Vec<PrevBlock>,
    pub prev_key_block_seqno: i32,
    pub rand_seed: String,
    pub root_hash: String,
    pub seqno: i32,
    pub shard: String,
    pub start_lt: String,
    pub tx_count: i32,
    pub validator_list_hash_short: i32,
    pub version: i32,
    pub vert_seqno: i32,
    pub vert_seqno_incr: bool,
    pub want_merge: bool,
    pub want_split: bool,
    pub workchain: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MasterChainBlockRef {
    pub seqno: i32,
    pub shard: String,
    pub workchain: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrevBlock {
    pub seqno: i32,
    pub shard: String,
    pub workchain: i32,
}
