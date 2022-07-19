use abacus_core::db::AbacusDB;
use abacus_core::db::DbError;
use eyre::Result;

static LATEST_VALID_MESSAGE_RANGE_START_BLOCK: &str = "latest_valid_message_range_start_block";
static LATEST_INDEXED_GAS_PAYMENT_BLOCK: &str = "latest_indexed_gas_payment_block";

pub(crate) trait OutboxContractSyncDB {
    fn store_latest_valid_message_range_start_block(&self, block_num: u32) -> Result<(), DbError>;
    fn retrieve_latest_valid_message_range_start_block(&self) -> Option<u32>;
}

impl OutboxContractSyncDB for AbacusDB {
    fn store_latest_valid_message_range_start_block(&self, block_num: u32) -> Result<(), DbError> {
        self.store_encodable("", LATEST_VALID_MESSAGE_RANGE_START_BLOCK, &block_num)
    }

    fn retrieve_latest_valid_message_range_start_block(&self) -> Option<u32> {
        self.retrieve_decodable("", LATEST_VALID_MESSAGE_RANGE_START_BLOCK)
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
