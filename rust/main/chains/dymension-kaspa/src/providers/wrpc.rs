use derive_new::new;
use tonic::async_trait;

use hyperlane_core::rpc_clients::BlockNumberGetter;
use hyperlane_core::{ChainCommunicationError, ChainResult};

#[derive(Debug, Clone, new)]
struct KaspaClient {}

#[async_trait]
impl BlockNumberGetter for KaspaClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}
