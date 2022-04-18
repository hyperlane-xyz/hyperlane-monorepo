#![allow(non_snake_case)]

use async_trait::async_trait;
use mockall::*;

use ethers::core::types::H256;

use abacus_core::{accumulator::merkle::Proof, *};

mock! {
    pub InboxContract {
        // Inbox
        pub fn _local_domain(&self) -> u32 {}

        pub fn _remote_domain(&self) -> Result<u32, ChainCommunicationError> {}

        pub fn _prove(&self, proof: &Proof) -> Result<TxOutcome, ChainCommunicationError> {}

        pub fn _process(
            &self,
            message: &AbacusMessage,
            proof: &Proof,
        ) -> Result<TxOutcome, ChainCommunicationError> {}

        pub fn _checkpoint(
            &self,
            signed_checkpoint: &SignedCheckpoint,
        ) -> Result<TxOutcome, ChainCommunicationError> {}

        // Common
        pub fn _name(&self) -> &str {}

        pub fn _status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {}

        pub fn _validator_manager(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _checkpointed_root(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {}

        pub fn _latest_checkpoint(&self, maybe_lag: Option<u64>) -> Result<Checkpoint, ChainCommunicationError> {}
    }
}

impl std::fmt::Debug for MockInboxContract {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockInboxContract")
    }
}

#[async_trait]
impl Inbox for MockInboxContract {
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError> {
        self._remote_domain()
    }

    async fn process(
        &self,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        self._process(message, proof)
    }

    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        self._message_status(leaf)
    }
}

#[async_trait]
impl AbacusCommon for MockInboxContract {
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

    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        self._latest_checkpoint(maybe_lag)
    }
}
