use std::ops::RangeInclusive;

use hyperlane_cosmos_rs::{hyperlane::core::post_dispatch::v1::EventGasPayment, prost::Name};
use tendermint::abci::EventAttribute;
use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster,
    InterchainGasPayment, LogMeta, SequenceAwareIndexer, H256, H512, U256,
};

use crate::{
    ConnectionConf, KaspaEventIndexer, KaspaProvider, HyperlaneKaspaError, RpcProvider,
};

use super::ParsedEvent;

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct KaspaInterchainGas {
    address: H256,
    domain: HyperlaneDomain,
    provider: KaspaProvider,
    native_token: String,
}

impl InterchainGasPaymaster for KaspaInterchainGas {}

impl KaspaInterchainGas {
    ///  Gas Payment Indexer
    pub fn new(
        provider: KaspaProvider,
        conf: &ConnectionConf,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(KaspaInterchainGas {
            address: locator.address,
            domain: locator.domain.clone(),
            native_token: conf.get_native_token().denom.clone(),
            provider,
        })
    }

    /// parses a kaspa sdk.Coin in a string representation '{amoun}{denom}'
    /// only returns the amount if it matches the native token in the config
    fn parse_gas_payment(&self, coin: &str) -> ChainResult<U256> {
        // Convert the coin to a u256 by taking everything before the first non-numeric character
        match coin.find(|c: char| !c.is_numeric()) {
            Some(first_non_numeric) => {
                let amount = U256::from_dec_str(&coin[..first_non_numeric])?;
                let denom = &coin[first_non_numeric..];
                if denom == self.native_token {
                    Ok(amount)
                } else {
                    Err(ChainCommunicationError::from_other_str(&format!(
                        "invalid gas payment: {coin} expected denom: {}",
                        self.native_token
                    )))
                }
            }
            None => Err(ChainCommunicationError::from_other_str(&format!(
                "invalid coin: {coin}"
            ))),
        }
    }
}

impl KaspaEventIndexer<InterchainGasPayment> for KaspaInterchainGas {
    fn target_type() -> String {
        EventGasPayment::full_name()
    }

    fn provider(&self) -> &RpcProvider {
        self.provider.rpc()
    }

    #[instrument(err)]
    fn parse(&self, attrs: &[EventAttribute]) -> ChainResult<ParsedEvent<InterchainGasPayment>> {
        let mut message_id: Option<H256> = None;
        let mut igp_id: Option<H256> = None;
        let mut gas_amount: Option<U256> = None;
        let mut payment: Option<U256> = None;
        let mut destination: Option<u32> = None;

        for attribute in attrs {
            let key = attribute.key_str().map_err(HyperlaneKaspaError::from)?;
            let value = attribute
                .value_str()
                .map_err(HyperlaneKaspaError::from)?
                .replace("\"", "");
            match key {
                "igp_id" => igp_id = Some(value.parse()?),
                "message_id" => message_id = Some(value.parse()?),
                "gas_amount" => gas_amount = Some(U256::from_dec_str(&value)?),
                "payment" => payment = Some(self.parse_gas_payment(&value)?),
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

    fn address(&self) -> &H256 {
        &self.address
    }
}

impl HyperlaneChain for KaspaInterchainGas {
    // Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    // A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for KaspaInterchainGas {
    // Return the address of this contract
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for KaspaInterchainGas {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        KaspaEventIndexer::fetch_logs_in_range(self, range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        KaspaEventIndexer::get_finalized_block_number(self).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        KaspaEventIndexer::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for KaspaInterchainGas {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = KaspaEventIndexer::get_finalized_block_number(self).await?;
        Ok((None, tip))
    }
}
