use std::ops::RangeInclusive;
use std::{io::Cursor, sync::Arc};

use ::futures::future;
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cosmrs::{tx::Raw, Any, Tx};
use hyperlane_core::{
    HyperlaneChain, HyperlaneDomain, InterchainGasPaymaster, InterchainGasPayment, U256,
};
use itertools::Itertools;
use once_cell::sync::Lazy;
use prost::Message;
use tendermint::abci::EventAttribute;
use tokio::{sync::futures, task::JoinHandle};
use tracing::{instrument, warn};

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, utils, ChainCommunicationError, ChainResult, ContractLocator,
    Decode, HyperlaneContract, HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

use crate::{
    ConnectionConf, CosmosNativeMailbox, CosmosNativeProvider, HyperlaneCosmosError,
    MsgProcessMessage, Signer,
};

use super::{EventIndexer, ParsedEvent};

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct CosmosNativeGasPaymaster {
    indexer: EventIndexer,
    address: H256,
    domain: HyperlaneDomain,
    provider: CosmosNativeProvider,
}

impl InterchainGasPaymaster for CosmosNativeGasPaymaster {}

impl CosmosNativeGasPaymaster {
    ///  Gas Payment Indexer
    pub fn new(conf: ConnectionConf, locator: ContractLocator) -> ChainResult<Self> {
        let provider =
            CosmosNativeProvider::new(locator.domain.clone(), conf.clone(), locator.clone(), None)?;
        Ok(CosmosNativeGasPaymaster {
            indexer: EventIndexer::new(
                "hyperlane.core.v1.GasPayment".to_string(),
                Arc::new(provider),
            ),
            address: locator.address.clone(),
            domain: locator.domain.clone(),
            provider: CosmosNativeProvider::new(locator.domain.clone(), conf, locator, None)?,
        })
    }

    #[instrument(err)]
    fn gas_payment_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<ParsedEvent<InterchainGasPayment>> {
        let mut message_id: Option<H256> = None;
        let mut igp_id: Option<H256> = None;
        let mut gas_amount: Option<U256> = None;
        let mut payment: Option<U256> = None;
        let mut destination: Option<u32> = None;

        for attribute in attrs {
            let key = attribute.key_str().map_err(HyperlaneCosmosError::from)?;
            let value = attribute
                .value_str()
                .map_err(HyperlaneCosmosError::from)?
                .replace("\"", "");
            match key {
                "igp_id" => igp_id = Some(value.parse()?),
                "message_id" => message_id = Some(value.parse()?),
                "gas_amount" => gas_amount = Some(U256::from_dec_str(&value)?),
                "payment" => payment = Some(U256::from_dec_str(&value)?),
                "destination" => destination = Some(value.parse()?),
                _ => continue,
            }
        }

        let message_id = message_id
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing message_id"))?;
        let igp_id =
            igp_id.ok_or_else(|| ChainCommunicationError::from_other_str("missing igp_id"))?;
        let gas_amount = gas_amount
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing gas_amount"))?;
        let payment =
            payment.ok_or_else(|| ChainCommunicationError::from_other_str("missing payment"))?;
        let destination = destination
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing destination"))?;

        Ok(ParsedEvent::new(
            igp_id,
            InterchainGasPayment {
                destination,
                message_id,
                payment,
                gas_amount,
            },
        ))
    }
}

impl HyperlaneChain for CosmosNativeGasPaymaster {
    // Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    // A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for CosmosNativeGasPaymaster {
    // Return the address of this contract
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for CosmosNativeGasPaymaster {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let result = self
            .indexer
            .fetch_logs_in_range(range, Self::gas_payment_parser)
            .await
            .map(|logs| {
                logs.into_iter()
                    .filter(|payment| payment.1.address == self.address)
                    .collect()
            });
        result
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let result = self
            .indexer
            .fetch_logs_by_tx_hash(tx_hash, Self::gas_payment_parser)
            .await
            .map(|logs| {
                let result = logs
                    .into_iter()
                    .filter(|payment| payment.1.address == self.address)
                    .collect();
                result
            });
        result
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for CosmosNativeGasPaymaster {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}
