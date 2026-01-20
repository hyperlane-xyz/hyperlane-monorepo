use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

use crate::interfaces::i_interchain_gas_paymaster::{
    GasPaymentFilter, IInterchainGasPaymaster as TronInterchainGasPaymasterInternal,
};
use crate::{fetch_raw_logs_and_meta, TronProvider};

#[derive(Debug)]
/// Struct that retrieves event data for an Tron InterchainGasPaymaster
pub struct TronInterchainGasPaymaster {
    contract: Arc<TronInterchainGasPaymasterInternal<TronProvider>>,
    provider: Arc<TronProvider>,
    domain: HyperlaneDomain,
}

impl TronInterchainGasPaymaster {
    /// Create new TronInterchainGasPaymasterIndexer
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        let provider = Arc::new(provider);
        Self {
            contract: Arc::new(TronInterchainGasPaymasterInternal::new(
                locator.address,
                provider.clone(),
            )),
            provider,
            domain: locator.domain.clone(),
        }
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for TronInterchainGasPaymaster {
    /// Note: This call may return duplicates depending on the provider used
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let events = self
            .contract
            .gas_payment_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?;

        Ok(events
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    Indexed::new(InterchainGasPayment {
                        message_id: H256::from(log.message_id),
                        destination: log.destination_domain,
                        payment: log.payment.into(),
                        gas_amount: log.gas_amount.into(),
                    }),
                    log_meta.into(),
                )
            })
            .collect())
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block_number().await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let raw_logs_and_meta = call_and_retry_indefinitely(|| {
            let provider = self.provider.clone();
            let contract = self.contract.address();
            Box::pin(async move {
                fetch_raw_logs_and_meta::<GasPaymentFilter, _>(tx_hash, provider, contract).await
            })
        })
        .await;

        let logs = raw_logs_and_meta
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    Indexed::new(InterchainGasPayment {
                        message_id: H256::from(log.message_id),
                        destination: log.destination_domain,
                        payment: log.payment.into(),
                        gas_amount: log.gas_amount.into(),
                    }),
                    log_meta,
                )
            })
            .collect();
        Ok(logs)
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for TronInterchainGasPaymaster {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}

impl HyperlaneChain for TronInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for TronInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl InterchainGasPaymaster for TronInterchainGasPaymaster {}
