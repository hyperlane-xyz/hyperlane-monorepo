#![allow(non_snake_case)]

use async_trait::async_trait;
use mockall::*;

use hyperlane_core::{accumulator::incremental::IncrementalMerkle, *};

mock! {
    pub MailboxContract {
        // Mailbox
        pub fn _address(&self) -> H256 {}

        pub fn _domain(&self) -> &HyperlaneDomain {}

        pub fn _provider(&self) -> Box<dyn HyperlaneProvider> {}

        pub fn _domain_hash(&self) -> H256 {}

        pub fn _raw_message_by_id(
            &self,
            leaf: H256,
        ) -> ChainResult<Option<RawHyperlaneMessage>> {}

        pub fn _id_by_nonce(
            &self,
            nonce: usize,
        ) -> ChainResult<Option<H256>> {}

        pub fn _tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle> {}

        pub fn _count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {}

        pub fn _latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {}

        pub fn _default_ism(&self) -> ChainResult<H256> {}
        pub fn _recipient_ism(&self, recipient: H256) -> ChainResult<H256> {}

        pub fn _delivered(&self, id: H256) -> ChainResult<bool> {}

        pub fn process(
            &self,
            message: &HyperlaneMessage,
            metadata: &[u8],
            tx_gas_limit: Option<U256>,
        ) -> ChainResult<TxOutcome> {}

        pub fn process_estimate_costs(
            &self,
            message: &HyperlaneMessage,
            metadata: &[u8],
        ) -> ChainResult<TxCostEstimate> {}

        pub fn process_calldata(
            &self,
            message: &HyperlaneMessage,
            metadata: &[u8],
        ) -> Vec<u8> {}

        pub fn process_batch<'a>(
            &self,
            ops: Vec<&'a QueueOperation>,
        ) -> ChainResult<BatchResult> {}

        pub fn supports_batching(&self) -> bool {
        }
    }
}

impl std::fmt::Debug for MockMailboxContract {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockMailboxContract")
    }
}

#[async_trait]
impl Mailbox for MockMailboxContract {
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        self._count(reorg_period)
    }

    async fn default_ism(&self) -> ChainResult<H256> {
        self._default_ism()
    }

    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        self._recipient_ism(recipient)
    }

    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        self._delivered(id)
    }

    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        self.process(message, metadata, tx_gas_limit)
    }

    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        self.process_estimate_costs(message, metadata)
    }

    async fn process_calldata(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        Ok(self.process_calldata(message, metadata))
    }

    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        Ok(None)
    }

    async fn process_batch<'a>(&self, ops: Vec<&'a QueueOperation>) -> ChainResult<BatchResult> {
        self.process_batch(ops)
    }

    fn supports_batching(&self) -> bool {
        self.supports_batching()
    }
}

impl HyperlaneChain for MockMailboxContract {
    fn domain(&self) -> &HyperlaneDomain {
        self._domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self._provider()
    }
}

impl HyperlaneContract for MockMailboxContract {
    fn address(&self) -> H256 {
        self._address()
    }
}

impl MockMailboxContract {
    pub fn new_with_default_ism(default_ism: H256) -> Self {
        let mut mock = Self::new();
        mock.expect__default_ism()
            .returning(move || Ok(default_ism));
        mock
    }
}
