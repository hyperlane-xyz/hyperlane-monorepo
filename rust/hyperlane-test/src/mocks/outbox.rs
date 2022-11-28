#![allow(non_snake_case)]

use async_trait::async_trait;
use ethers::core::types::H256;
use mockall::*;

use hyperlane_core::*;

mock! {
    pub OutboxContract {
        // Outbox
        pub fn _address(&self) -> H256 {}

        pub fn _local_domain(&self) -> u32 {}

        pub fn _domain_hash(&self) -> H256 {}

        pub fn _raw_message_by_leaf(
            &self,
            leaf: H256,
        ) -> Result<Option<RawCommittedMessage>, ChainCommunicationError> {}

        pub fn _leaf_by_tree_index(
            &self,
            tree_index: usize,
        ) -> Result<Option<H256>, ChainCommunicationError> {}

        pub fn _dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError> {}

        pub fn _count(&self) -> Result<u32, ChainCommunicationError> {}

        pub fn _cache_checkpoint(&self) -> Result<TxOutcome, ChainCommunicationError> {}

        pub fn _latest_cached_root(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _latest_cached_checkpoint(&self) -> Result<Checkpoint, ChainCommunicationError> {}

        pub fn _latest_checkpoint(&self, maybe_lag: Option<u64>) -> Result<Checkpoint, ChainCommunicationError> {}

        // HyperlaneCommon
        pub fn _validator_manager(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _state(&self) -> Result<OutboxState, ChainCommunicationError> {}

        // HyperlaneContract
        pub fn _chain_name(&self) -> &str {}
    }
}

impl std::fmt::Debug for MockOutboxContract {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockOutboxContract")
    }
}

#[async_trait]
impl Outbox for MockOutboxContract {
    async fn state(&self) -> Result<OutboxState, ChainCommunicationError> {
        self._state()
    }

    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        self._count()
    }

    async fn dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError> {
        self._dispatch(message)
    }

    async fn cache_checkpoint(&self) -> Result<TxOutcome, ChainCommunicationError> {
        self._cache_checkpoint()
    }

    async fn latest_cached_root(&self) -> Result<H256, ChainCommunicationError> {
        self._latest_cached_root()
    }

    async fn latest_cached_checkpoint(&self) -> Result<Checkpoint, ChainCommunicationError> {
        self._latest_cached_checkpoint()
    }

    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        self._latest_checkpoint(maybe_lag)
    }
}

impl HyperlaneChain for MockOutboxContract {
    fn chain_name(&self) -> &str {
        self._chain_name()
    }

    fn local_domain(&self) -> u32 {
        self._local_domain()
    }
}

impl HyperlaneContract for MockOutboxContract {
    fn address(&self) -> H256 {
        self._address()
    }
}

#[async_trait]
impl HyperlaneCommon for MockOutboxContract {
    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self._validator_manager()
    }
}
