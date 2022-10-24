#![allow(non_snake_case)]

use async_trait::async_trait;
use mockall::*;

use ethers::types::H256;

use abacus_core::{accumulator::merkle::Proof, *};

mock! {
    pub InboxContract {
        // Inbox
        pub fn _address(&self) -> H256 {}

        pub fn _local_domain(&self) -> u32 {}

        pub fn _contract_address(&self) -> Address {}

        pub fn _remote_domain(&self) -> Result<u32, ChainCommunicationError> {}

        pub fn _prove(&self, proof: &Proof) -> Result<TxOutcome, ChainCommunicationError> {}

        pub fn _checkpoint(
            &self,
            signed_checkpoint: &SignedCheckpoint,
        ) -> Result<TxOutcome, ChainCommunicationError> {}

        // AbacusCommon
        pub fn _status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {}

        pub fn _validator_manager(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {}

        // AbacusContract
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
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError> {
        self._remote_domain()
    }

    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        self._message_status(leaf)
    }

    fn contract_address(&self) -> Address {
        self._contract_address()
    }
}

impl AbacusContract for MockInboxContract {
    fn chain_name(&self) -> &str {
        self._chain_name()
    }

    fn address(&self) -> H256 {
        self._address()
    }
}

#[async_trait]
impl AbacusCommon for MockInboxContract {
    fn local_domain(&self) -> u32 {
        self._local_domain()
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self._status(txid)
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self._validator_manager()
    }
}
