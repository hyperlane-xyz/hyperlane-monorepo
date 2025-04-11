use crate::{
    contracts::mailbox::Mailbox as FuelMailboxInner, conversions::*, ConnectionConf, FuelProvider,
};
use async_trait::async_trait;
use fuels::{
    prelude::{Bech32ContractId, WalletUnlocked},
    tx::{Receipt, ScriptExecutionResult},
    types::{transaction::TxPolicies, Bytes},
};
use hyperlane_core::{
    utils::bytes_to_hex, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneAbi,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Indexed, Indexer, LogMeta, Mailbox, RawHyperlaneMessage, ReorgPeriod, SequenceAwareIndexer,
    TxCostEstimate, TxOutcome, H256, H512, U256,
};
use std::{
    collections::HashMap,
    fmt::{Debug, Formatter},
    ops::RangeInclusive,
};
use tracing::{instrument, warn};

/// A reference to a Mailbox contract on some Fuel chain
pub struct FuelMailbox {
    contract: FuelMailboxInner<WalletUnlocked>,
    provider: FuelProvider,
    domain: HyperlaneDomain,
}

impl FuelMailbox {
    /// Create a new fuel mailbox
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelMailbox {
            contract: FuelMailboxInner::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelMailbox {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl Debug for FuelMailbox {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self as &dyn HyperlaneContract)
    }
}

#[async_trait]
impl Mailbox for FuelMailbox {
    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        assert!(
            reorg_period.is_none(),
            "Fuel does not support querying point-in-time"
        );
        self.contract
            .methods()
            .nonce()
            .simulate()
            .await
            .map(|r| r.value)
            .map_err(ChainCommunicationError::from_other)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        self.contract
            .methods()
            .delivered(fuels::types::Bits256::from_h256(&id))
            .simulate()
            .await
            .map(|r| r.value)
            .map_err(ChainCommunicationError::from_other)
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn default_ism(&self) -> ChainResult<H256> {
        self.contract
            .methods()
            .default_ism()
            .simulate()
            .await
            .map(|r| r.value.into_h256())
            .map_err(ChainCommunicationError::from_other)
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        self.contract
            .methods()
            .recipient_ism(Bech32ContractId::from_h256(&recipient))
            .simulate()
            .await
            .map(|r| r.value.into_h256())
            .map_err(ChainCommunicationError::from_other)
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        // The max gas limit per transaction is 30000000 so it should always be safe to convert to u64
        let tx_policies = match tx_gas_limit {
            Some(gas_limit) if gas_limit <= U256::from(u64::MAX) => {
                match u64::try_from(gas_limit) {
                    Ok(parsed_gas_limit) => {
                        TxPolicies::default().with_script_gas_limit(parsed_gas_limit)
                    }
                    Err(_) => {
                        warn!("Failed to convert U256 to u64 during process call");
                        TxPolicies::default()
                    }
                }
            }
            _ => TxPolicies::default(),
        };

        let gas_price = self.provider.get_gas_price().await?;

        let call_res = self
            .contract
            .methods()
            .process(
                Bytes(metadata.to_vec()),
                Bytes(RawHyperlaneMessage::from(message)),
            )
            .with_tx_policies(tx_policies)
            .determine_missing_contracts(Some(3))
            .await
            .map_err(ChainCommunicationError::from_other)?
            .call()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        // Extract transaction success from the receipts
        let success = call_res
            .receipts
            .iter()
            .filter_map(|r| match r {
                Receipt::ScriptResult { result, .. } => Some(result),
                _ => None,
            })
            .any(|result| matches!(result, ScriptExecutionResult::Success));

        let tx_id = H512::from(call_res.tx_id.unwrap().into_h256());
        Ok(TxOutcome {
            transaction_id: tx_id,
            executed: success,
            gas_used: call_res.gas_used.into(),
            gas_price: gas_price.into(),
        })
    }

    // Process cost of the `process` method
    #[instrument(err, ret, skip(self), fields(hyp_message=%message, metadata=%bytes_to_hex(metadata)))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let call_res = self
            .contract
            .methods()
            .process(
                Bytes(metadata.to_vec()),
                Bytes(RawHyperlaneMessage::from(message)),
            )
            .determine_missing_contracts(Some(3))
            .await
            .map_err(ChainCommunicationError::from_other)?
            .estimate_transaction_cost(None, None)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        Ok(TxCostEstimate {
            gas_limit: call_res.total_fee.into(),
            gas_price: call_res.gas_price.into(),
            l2_gas_limit: None,
        })
    }

    async fn process_calldata(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        // Seems like this is not needed for Fuel, as it's only used in mocks
        todo!()
    }
}

/// Struct that retrieves event data for a Fuel Mailbox contract
#[derive(Debug)]
pub struct FuelMailboxIndexer {
    contract: FuelMailboxInner<WalletUnlocked>,
    provider: FuelProvider,
}

impl FuelMailboxIndexer {
    /// Create a new FuelMailboxIndexer
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        let address = Bech32ContractId::from_h256(&locator.address);
        let contract = FuelMailboxInner::new(address, wallet);

        Ok(FuelMailboxIndexer {
            contract,
            provider: fuel_provider,
        })
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for FuelMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let mailbox_address = self.contract.contract_id().clone();
        self.provider
            .index_logs_in_range(range, mailbox_address)
            .await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block_number().await
    }
}

#[async_trait]
impl Indexer<H256> for FuelMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        todo!() // Needed for scraper
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for FuelMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<H256>::get_finalized_block_number(&self).await?;

        // No sequence for message deliveries.
        Ok((None, tip))
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for FuelMailboxIndexer {
    #[allow(clippy::unnecessary_cast)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(&self).await?;

        self.contract
            .methods()
            .nonce()
            .simulate()
            .await
            .map(|r| r.value)
            .map_err(ChainCommunicationError::from_other)
            .map(|sequence| (Some(sequence as u32), tip))
    }
}

#[allow(dead_code)] // TODO: Remove this once the FuelMailboxAbi is implemented
struct FuelMailboxAbi;

impl HyperlaneAbi for FuelMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 8;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        // Can't support this without Fuels exporting it in the generated code
        todo!()
    }
}
