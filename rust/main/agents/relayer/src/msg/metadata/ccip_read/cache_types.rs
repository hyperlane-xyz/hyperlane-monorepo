use serde::{Deserialize, Serialize};

use hyperlane_ethereum::OffchainLookup;

#[allow(missing_docs)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedOffchainLookup {
    pub sender: ethers::core::types::Address,
    pub urls: ::std::vec::Vec<String>,
    pub call_data: ethers::core::types::Bytes,
    pub callback_function: [u8; 4],
    pub extra_data: ethers::core::types::Bytes,
}

impl From<OffchainLookup> for SerializedOffchainLookup {
    fn from(lookup: OffchainLookup) -> Self {
        Self {
            sender: lookup.sender,
            urls: lookup.urls,
            call_data: lookup.call_data,
            callback_function: lookup.callback_function,
            extra_data: lookup.extra_data,
        }
    }
}

impl From<SerializedOffchainLookup> for OffchainLookup {
    fn from(lookup: SerializedOffchainLookup) -> Self {
        Self {
            sender: lookup.sender,
            urls: lookup.urls,
            call_data: lookup.call_data,
            callback_function: lookup.callback_function,
            extra_data: lookup.extra_data,
        }
    }
}
