use abacus_core::db::AbacusDB;
use abacus_core::db::DbError;
use color_eyre::Result;

static MESSAGES_LAST_BLOCK_END: &str = "messages_last_inspected";

pub(crate) trait OutboxContractSyncDB {
    fn store_message_latest_block_end(&self, latest_block: u32) -> Result<(), DbError>;
    fn retrieve_message_latest_block_end(&self) -> Option<u32>;
}

impl OutboxContractSyncDB for AbacusDB {
    fn store_message_latest_block_end(&self, latest_block: u32) -> Result<(), DbError> {
        self.store_encodable("", MESSAGES_LAST_BLOCK_END, &latest_block)
    }

    fn retrieve_message_latest_block_end(&self) -> Option<u32> {
        self.retrieve_decodable("", MESSAGES_LAST_BLOCK_END)
            .expect("db failure")
    }
}
