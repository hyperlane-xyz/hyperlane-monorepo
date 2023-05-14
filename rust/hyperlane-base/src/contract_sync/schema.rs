use eyre::Result;

use crate::db::{DbError, HyperlaneRocksDB};

/// The start block number of the latest "valid" message block range.
/// This is an interval of block indexes where > 0 messages were indexed,
/// all of which had a contiguous sequence of messages based off their indices,
/// and the lowest index is the successor to the highest index of the prior
/// valid range.
static LATEST_VALID_MESSAGE_RANGE_START_BLOCK: &str = "latest_valid_message_range_start_block";
static LATEST_INDEXED_GAS_PAYMENT_BLOCK: &str = "latest_indexed_gas_payment_block";

// TODO: Can all of these be deleted?
pub(crate) trait MailboxContractSyncDB {
    fn store_latest_valid_message_range_start_block(&self, block_num: u32) -> Result<(), DbError>;
    fn retrieve_latest_valid_message_range_start_block(&self) -> Option<u32>;
}

impl MailboxContractSyncDB for HyperlaneRocksDB {
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

impl InterchainGasPaymasterContractSyncDB for HyperlaneRocksDB {
    fn store_latest_indexed_gas_payment_block(&self, latest_block: u32) -> Result<(), DbError> {
        self.store_encodable("", LATEST_INDEXED_GAS_PAYMENT_BLOCK, &latest_block)
    }

    fn retrieve_latest_indexed_gas_payment_block(&self) -> Option<u32> {
        self.retrieve_decodable("", LATEST_INDEXED_GAS_PAYMENT_BLOCK)
            .expect("db failure")
    }
}
