#![allow(non_snake_case)]

use async_trait::async_trait;
use mockall::*;
use eyre::Result;

use ethers::{core::types::H256, types::U256};

use abacus_core::{*};

mock! {
    pub MailboxContract {
        // Mailbox
        pub fn _address(&self) -> H256 {}

        pub fn _local_domain(&self) -> u32 {}

        pub fn _domain_hash(&self) -> H256 {}

        pub fn _raw_message_by_id(
            &self,
            leaf: H256,
        ) -> Result<Option<RawAbacusMessage>, ChainCommunicationError> {}

        pub fn _id_by_nonce(
            &self,
            nonce: usize,
        ) -> Result<Option<H256>, ChainCommunicationError> {}

        pub fn _count(&self) -> Result<u32, ChainCommunicationError> {}

        pub fn _latest_checkpoint(&self, maybe_lag: Option<u64>) -> Result<Checkpoint, ChainCommunicationError> {}

        pub fn _status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {}

        pub fn _default_module(&self) -> Result<H256, ChainCommunicationError> {}

        pub fn _delivered(&self, id: H256) -> Result<bool, ChainCommunicationError> {}

        pub fn process(
            &self,
            message: &AbacusMessage,
            metadata: &Vec<u8>,
            tx_gas_limit: Option<U256>,
        ) -> Result<TxOutcome, ChainCommunicationError> {}

        pub fn process_estimate_costs(
            &self,
            message: &AbacusMessage,
            metadata: &Vec<u8>,
        ) -> Result<TxCostEstimate> {}

        pub fn process_calldata(
            &self,
            message: &AbacusMessage,
            metadata: &Vec<u8>,
        ) -> Vec<u8> {}

        // AbacusContract
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

    fn local_domain(&self) -> u32 {
        self._local_domain()
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self._status(txid)
    }

    async fn default_module(&self) -> Result<H256, ChainCommunicationError> {
        self._default_module()
    }

    async fn delivered(&self, id: H256) -> Result<bool, ChainCommunicationError> {
        self._delivered(id)
    }

    async fn process(
        &self,
        message: &AbacusMessage,
        metadata: &Vec<u8>,
        tx_gas_limit: Option<U256>,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        self.process(message, metadata, tx_gas_limit)
    }

    async fn process_estimate_costs(
        &self,
        message: &AbacusMessage,
        metadata: &Vec<u8>,
    ) -> Result<TxCostEstimate> {
        self.process_estimate_costs(message, metadata)
    }

    fn process_calldata(
        &self,
        message: &AbacusMessage,
        metadata: &Vec<u8>,
    ) -> Vec<u8> {
        self.process_calldata(message, metadata)
    }
}

impl AbacusContract for MockMailboxContract {
    fn chain_name(&self) -> &str {
        self._chain_name()
    }

    fn address(&self) -> H256 {
        self._address()
    }
}
