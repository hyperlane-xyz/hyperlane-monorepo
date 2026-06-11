use std::collections::HashSet;
use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H160, H256, H512,
};

use crate::interfaces::i_interchain_gas_paymaster::{
    GasPaymentFilter, GasPaymentWithFeeTokenFilter,
    IInterchainGasPaymaster as TronInterchainGasPaymasterInternal,
};
use crate::{fetch_raw_logs_and_meta, TronProvider};

#[derive(Debug)]
/// Struct that retrieves event data for a Tron InterchainGasPaymaster
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

    fn legacy_payment(log: GasPaymentFilter) -> InterchainGasPayment {
        InterchainGasPayment {
            message_id: H256::from(log.message_id),
            destination: log.destination_domain,
            fee_token: H160::zero(),
            payment: log.payment.into(),
            gas_amount: log.gas_amount.into(),
        }
    }

    fn token_payment(log: GasPaymentWithFeeTokenFilter) -> InterchainGasPayment {
        InterchainGasPayment {
            message_id: H256::from(log.message_id),
            destination: log.destination_domain,
            fee_token: H160::from(log.fee_token),
            payment: log.payment.into(),
            gas_amount: log.gas_amount.into(),
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
        let legacy_events = self
            .contract
            .gas_payment_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?;
        let token_events = self
            .contract
            .gas_payment_with_fee_token_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?;

        let token_event_txs = token_events
            .iter()
            .map(|(_, log_meta)| LogMeta::from(log_meta.clone()).transaction_id)
            .collect::<HashSet<_>>();

        Ok(legacy_events
            .into_iter()
            .filter(|(_, log_meta)| {
                !token_event_txs.contains(&LogMeta::from(log_meta.clone()).transaction_id)
            })
            .map(|(log, log_meta)| (Indexed::new(Self::legacy_payment(log)), log_meta.into()))
            .chain(
                token_events.into_iter().map(|(log, log_meta)| {
                    (Indexed::new(Self::token_payment(log)), log_meta.into())
                }),
            )
            .collect())
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block_number().await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let token_logs_and_meta = call_and_retry_indefinitely(|| {
            let provider = self.provider.clone();
            let contract = self.contract.address();
            Box::pin(async move {
                fetch_raw_logs_and_meta::<GasPaymentWithFeeTokenFilter, _>(
                    tx_hash, provider, contract,
                )
                .await
            })
        })
        .await;

        if !token_logs_and_meta.is_empty() {
            return Ok(token_logs_and_meta
                .into_iter()
                .map(|(log, log_meta)| (Indexed::new(Self::token_payment(log)), log_meta))
                .collect());
        }

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
            .map(|(log, log_meta)| (Indexed::new(Self::legacy_payment(log)), log_meta))
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
