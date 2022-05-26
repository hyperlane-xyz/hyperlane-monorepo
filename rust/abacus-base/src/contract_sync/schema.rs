use abacus_core::db::AbacusDB;
use abacus_core::db::DbError;
use eyre::Result;

static MESSAGES_LAST_BLOCK_END: &str = "messages_last_inspected";
static LATEST_INDEXED_GAS_PAYMENT_BLOCK: &str = "latest_indexed_gas_payment_block";

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

pub(crate) trait InterchainGasPaymasterContractSyncDB {
    fn store_latest_indexed_gas_payment_block(&self, latest_block: u32) -> Result<(), DbError>;
    fn retrieve_latest_indexed_gas_payment_block(&self) -> Option<u32>;
}

impl InterchainGasPaymasterContractSyncDB for AbacusDB {
    fn store_latest_indexed_gas_payment_block(&self, latest_block: u32) -> Result<(), DbError> {
        self.store_encodable("", LATEST_INDEXED_GAS_PAYMENT_BLOCK, &latest_block)
    }

    fn retrieve_latest_indexed_gas_payment_block(&self) -> Option<u32> {
        self.retrieve_decodable("", LATEST_INDEXED_GAS_PAYMENT_BLOCK)
            .expect("db failure")
    }
}