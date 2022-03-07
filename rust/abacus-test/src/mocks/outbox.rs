#![allow(non_snake_case)]

use async_trait::async_trait;
use mockall::*;

use ethers::core::types::H256;

use abacus_core::*;

mock! {
    pub OutboxContract {
        // Home
        pub fn _local_domain(&self) -> u32 {}

        pub fn _domain_hash(&self) -> H256 {}

        pub fn _raw_message_by_nonce(
            &self,
            destination: u32,
            nonce: u32,
        ) -> Result<Option<RawCommittedMessage>, ChainCommunicationError> {}

        pub fn _raw_message_by_leaf(
            &self,
            leaf: H256,
        ) -> Result<Option<RawCommittedMessage>, ChainCommunicationError> {}


        pub fn _leaf_by_tree_index(
            &self,
            tree_index: usize,
        ) -> Result<Option<H256>, ChainCommunicationError> {}

        pub fn _nonces(&self, destination: u32) -> Result<u32, ChainCommunicationError> {}

        pub fn _dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError> {}

        // Common
        pub fn _name(&self) -> &str {}

        pub fn _status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {}

        pub fn _validator_manager(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _state(&self) -> Result<State, ChainCommunicationError> {}

        pub fn _checkpointed_root(&self) -> Result<H256, ChainCommunicationError> {}
    }
}

impl std::fmt::Debug for MockOutboxContract {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockOutboxContract")
    }
}

#[async_trait]
impl Outbox for MockOutboxContract {
    async fn nonces(&self, destination: u32) -> Result<u32, ChainCommunicationError> {
        self._nonces(destination)
    }

    async fn dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError> {
        self._dispatch(message)
    }

    async fn state(&self) -> Result<State, ChainCommunicationError> {
        self._state()
    }
}

#[async_trait]
impl AbacusCommon for MockOutboxContract {
    fn name(&self) -> &str {
        self._name()
    }

    fn local_domain(&self) -> u32 {
        self._local_domain()
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self._status(txid)
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self._validator_manager()
    }

    async fn checkpointed_root(&self) -> Result<H256, ChainCommunicationError> {
        self._checkpointed_root()
    }
}
