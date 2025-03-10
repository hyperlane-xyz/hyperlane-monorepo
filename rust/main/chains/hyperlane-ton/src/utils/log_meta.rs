use hyperlane_core::{LogMeta, H256};

pub fn create_ton_log_meta(address: H256) -> LogMeta {
    LogMeta {
        address,
        block_number: 0, // TON does not yet support this metric in logs
        block_hash: Default::default(),
        transaction_id: Default::default(),
        transaction_index: 0,
        log_index: Default::default(),
    }
}
