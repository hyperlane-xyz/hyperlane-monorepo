#![allow(non_snake_case)]

use async_trait::async_trait;
use eyre::Result;
use mockall::*;

use ethers::{core::types::H256, types::U256};

use hyperlane_core::*;

mock! {
    pub MailboxContract {
        // Mailbox
        pub fn _address(&self) -> H256 {}

        pub fn _local_domain(&self) -> u32 {}

        pub fn _domain_hash(&self) -> H256 {}

        pub fn _raw_message_by_id(
            &self,
            leaf: H256,
        ) -> Result<Option<RawHyperlaneMessage>, ChainCommunicationError> {}

        pub fn _id_by_nonce(
            &self,
            nonce: usize,
        ) -> Result<Option<H256>, ChainCommunicationError> {}

        pub fn _count(&self) -> Result<u32, ChainCommunicationError> {}

        pub fn _latest_checkpoint(&self, maybe_lag: Option<u64>) -> Result<Checkpoint, ChainCommunicationError> {}

        pub fn _status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {}

        pub fn _default_ism(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _delivered(&self, id: H256) -> Result<bool, ChainCommunicationError> {}

        pub fn process(
            &self,
            message: &HyperlaneMessage,
            metadata: &[u8],
            tx_gas_limit: Option<U256>,
        ) -> Result<TxOutcome, ChainCommunicationError> {}

        pub fn process_estimate_costs(
            &self,
            message: &HyperlaneMessage,
            metadata: &[u8],
        ) -> Result<TxCostEstimate> {}

        pub fn process_calldata(
            &self,
            message: &HyperlaneMessage,
            metadata: &[u8],
        ) -> Vec<u8> {}

        // HyperlaneContract
        pub fn _chain_name(&self) -> &str {}
    }
}

impl std::fmt::Debug for MockMailboxContract {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockMailboxContract")
    }
}

#[async_trait]
impl Mailbox for MockMailboxContract {
    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        self._count()
    }

    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        self._latest_checkpoint(maybe_lag)
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self._status(txid)
    }

    async fn default_ism(&self) -> Result<H256, ChainCommunicationError> {
        self._default_ism()
    }

    async fn delivered(&self, id: H256) -> Result<bool, ChainCommunicationError> {
        self._delivered(id)
    }

    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        self.process(message, metadata, tx_gas_limit)
    }

    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> Result<TxCostEstimate> {
        self.process_estimate_costs(message, metadata)
    }

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        self.process_calldata(message, metadata)
    }
}

impl HyperlaneChain for MockMailboxContract {
    fn local_domain(&self) -> u32 {
        self._local_domain()
    }

    fn chain_name(&self) -> &str {
        self._chain_name()
    }
}

impl HyperlaneContract for MockMailboxContract {
    fn address(&self) -> H256 {
        self._address()
    }
}
