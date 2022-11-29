#![allow(non_snake_case)]

use async_trait::async_trait;
use ethers::types::H256;
use mockall::*;

use hyperlane_core::{accumulator::merkle::Proof, *};

mock! {
    pub InboxContract {
        // Inbox
        pub fn _address(&self) -> H256 {}

        pub fn _local_domain(&self) -> u32 {}

        pub fn _contract_address(&self) -> Address {}

        pub fn _remote_domain(&self) -> u32 {}

        pub fn _prove(&self, proof: &Proof) -> Result<TxOutcome, ChainCommunicationError> {}

        pub fn _checkpoint(
            &self,
            signed_checkpoint: &SignedCheckpoint,
        ) -> Result<TxOutcome, ChainCommunicationError> {}

        // HyperlaneCommon
        pub fn _status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {}

        pub fn _validator_manager(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {}

        // HyperlaneContract
        pub fn _chain_name(&self) -> &str {}
    }
}

impl std::fmt::Debug for MockInboxContract {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockInboxContract")
    }
}

#[async_trait]
impl Inbox for MockInboxContract {
    fn remote_domain(&self) -> u32 {
        self._remote_domain()
    }

    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        self._message_status(leaf)
    }

    fn contract_address(&self) -> Address {
        self._contract_address()
    }
}

impl HyperlaneChain for MockInboxContract {
    fn chain_name(&self) -> &str {
        self._chain_name()
    }

    fn local_domain(&self) -> u32 {
        self._local_domain()
    }
}

impl HyperlaneContract for MockInboxContract {
    fn address(&self) -> H256 {
        self._address()
    }
}

#[async_trait]
impl HyperlaneCommon for MockInboxContract {
    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self._validator_manager()
    }
}
