use std::{
    fmt::{Debug, Formatter},
    ops::RangeInclusive,
};

use async_trait::async_trait;
use fuels::{
    prelude::Bech32ContractId,
    programs::calls::Execution,
    tx::{Receipt, ScriptExecutionResult},
    types::{transaction::TxPolicies, transaction_builders::VariableOutputPolicy, Bytes},
};
use tracing::{instrument, warn};

use hyperlane_core::{
    utils::bytes_to_hex, ChainCommunicationError, ChainResult, ContractLocator, Delivery,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Indexed, Indexer, LogMeta, Mailbox, RawHyperlaneMessage, ReorgPeriod, SequenceAwareIndexer,
    TxCostEstimate, TxOutcome, H256, H512, U256,
};

use crate::{
    contracts::mailbox::{DispatchEvent, Mailbox as FuelMailboxContract, ProcessIdEvent},
    conversions::*,
    wallet::FuelWallets,
    ConnectionConf, FuelIndexer, FuelProvider,
};

const GAS_ESTIMATE_MULTIPLIER: f64 = 1.3;
/// A reference to a Mailbox contract on some Fuel chain
pub struct FuelMailbox {
    contract: FuelMailboxContract<FuelWallets>,
    provider: FuelProvider,
    domain: HyperlaneDomain,
}

impl FuelMailbox {
    /// Create a new fuel mailbox
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: FuelWallets,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelMailbox {
            contract: FuelMailboxContract::new(address, wallet),
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
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        self.contract
            .methods()
            .nonce()
            .simulate(Execution::state_read_only())
            .await
            .map(|r| r.value)
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to read nonce for mailbox contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        self.contract
            .methods()
            .delivered(fuels::types::Bits256::from_h256(&id))
            .simulate(Execution::state_read_only())
            .await
            .map(|r| r.value)
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to read delivered status for message 0x{:?} - {:?}",
                        id, e
                    )
                    .as_str(),
                )
            })
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn default_ism(&self) -> ChainResult<H256> {
        self.contract
            .methods()
            .default_ism()
            .simulate(Execution::state_read_only())
            .await
            .map(|r| r.value.into_h256())
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to read default ISM for mailbox contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let parsed_recipient = Bech32ContractId::from_h256(&recipient);
        self.contract
            .methods()
            .recipient_ism(parsed_recipient.clone())
            .with_contract_ids(&[parsed_recipient])
            .simulate(Execution::state_read_only())
            .await
            .map(|r| r.value.into_h256())
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to read recipient ISM for mailbox contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
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
            .with_variable_output_policy(VariableOutputPolicy::EstimateMinimum)
            .with_tx_policies(tx_policies)
            .determine_missing_contracts()
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to determine missing contracts for process call of mailbox contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })?
            .call()
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to call process for mailbox contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })?;

        // Extract transaction success from the receipts
        let success = call_res
            .tx_status
            .receipts
            .iter()
            .filter_map(|r| match r {
                Receipt::ScriptResult { result, .. } => Some(result),
                _ => None,
            })
            .any(|result| matches!(result, ScriptExecutionResult::Success));

        let tx_id = match call_res.tx_id {
            Some(tx_id) => H512::from(tx_id.into_h256()),
            None => {
                return Err(ChainCommunicationError::from_other_str(
                    "Transaction ID not found",
                ))
            }
        };

        Ok(TxOutcome {
            transaction_id: tx_id,
            executed: success,
            gas_used: call_res.tx_status.total_gas.into(),
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
        let gas_price = self.provider.get_gas_price().await?;

        let simulate_call = self
            .contract
            .methods()
            .process(
                Bytes(metadata.to_vec()),
                Bytes(RawHyperlaneMessage::from(message)),
            )
            .with_variable_output_policy(VariableOutputPolicy::EstimateMinimum)
            .determine_missing_contracts()
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to determine missing contracts for process cost estimation of mailbox contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })?
            .simulate(Execution::realistic())
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to read process call cost for mailbox contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })?;

        Ok(TxCostEstimate {
            gas_limit: ((simulate_call.tx_status.total_gas as f64 * GAS_ESTIMATE_MULTIPLIER)
                as u64)
                .into(),
            gas_price: gas_price.into(),
            l2_gas_limit: None,
        })
    }

    fn process_calldata(&self, _message: &HyperlaneMessage, _metadata: &[u8]) -> Vec<u8> {
        todo!() // not required
    }
}

// ----------------------------------------------------------
// ------------------ Dispatch Indexer ----------------------
// ----------------------------------------------------------

/// Struct that retrieves Dispatch events from a Fuel Mailbox contract
#[derive(Debug)]
pub struct FuelDispatchIndexer {
    indexer: FuelIndexer<DispatchEvent>,
    contract: FuelMailboxContract<FuelWallets>,
}

impl FuelDispatchIndexer {
    /// Create a new FuelMailboxIndexer
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: FuelWallets,
    ) -> ChainResult<Self> {
        let contract = FuelMailboxContract::new(
            Bech32ContractId::from_h256(&locator.address),
            wallet.clone(),
        );

        let indexer = FuelIndexer::new(conf, locator, wallet).await;
        Ok(Self { indexer, contract })
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for FuelDispatchIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        self.indexer.index_logs_in_range(range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.provider().get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for FuelDispatchIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(&self).await?;

        self.contract
            .methods()
            .nonce()
            .simulate(Execution::state_read_only())
            .await
            .map(|r| r.value)
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to read nonce for mailbox contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
            .map(|sequence| (Some(sequence), tip))
    }
}

// ----------------------------------------------------------
// ------------------ Delivery Indexer ----------------------
// ----------------------------------------------------------

/// Struct that retrieves ProcessId events from a Fuel Mailbox contract
#[derive(Debug)]
pub struct FuelDeliveryIndexer {
    indexer: FuelIndexer<ProcessIdEvent>,
}

impl FuelDeliveryIndexer {
    /// Create a new FuelMailboxIndexer
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: FuelWallets,
    ) -> ChainResult<Self> {
        let indexer = FuelIndexer::new(conf, locator, wallet).await;
        Ok(Self { indexer })
    }
}

#[async_trait]
impl Indexer<Delivery> for FuelDeliveryIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<Delivery>, LogMeta)>> {
        self.indexer.index_logs_in_range(range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.provider().get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<Delivery> for FuelDeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<Delivery>::get_finalized_block_number(&self).await?;
        // No sequence for message deliveries.
        Ok((None, tip))
    }
}
