use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, Indexer,
    InterchainGasPaymaster, SequenceIndexer, U256,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneProvider, InterchainGasPayment, LogMeta, H256};
use std::ops::RangeInclusive;

use crate::grpc::WasmGrpcProvider;
use crate::rpc::{CosmosWasmIndexer, WasmIndexer};
use crate::signers::Signer;
use crate::{ConnectionConf, CosmosProvider};

/// A reference to a InterchainGasPaymaster contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymaster {
    domain: HyperlaneDomain,
    address: H256,
}

impl HyperlaneContract for CosmosInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(CosmosProvider::new(self.domain.clone()))
    }
}

impl InterchainGasPaymaster for CosmosInterchainGasPaymaster {}

impl CosmosInterchainGasPaymaster {
    /// create new Cosmos InterchainGasPaymaster agent
    pub fn new(conf: ConnectionConf, locator: ContractLocator, signer: Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

        Self {
            domain: locator.domain.clone(),
            address: locator.address,
        }
    }
}

/// A reference to a InterchainGasPaymasterIndexer contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymasterIndexer {
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosInterchainGasPaymasterIndexer {
    /// create new Cosmos InterchainGasPaymasterIndexer agent
    pub fn new(conf: ConnectionConf, locator: ContractLocator, event_type: String) -> Self {
        let indexer: CosmosWasmIndexer = CosmosWasmIndexer::new(conf, locator, event_type.clone());

        Self {
            indexer: Box::new(indexer),
        }
    }

    fn get_parser(
        &self,
    ) -> fn(attrs: Vec<EventAttribute>) -> ChainResult<Option<InterchainGasPayment>> {
        |attrs: Vec<EventAttribute>| -> ChainResult<Option<InterchainGasPayment>> {
            let mut res = InterchainGasPayment::default();
            for attr in attrs {
                let key = attr.key.as_str();
                let value = attr.value;
                let value = value.as_str();

                match key {
                    "message_id" => {
                        res.message_id = H256::from_slice(hex::decode(value)?.as_slice())
                    }
                    "bWVzc2FnZV9pZA==" => {
                        res.message_id = H256::from_slice(
                            hex::decode(String::from_utf8(STANDARD.decode(value)?)?)?.as_slice(),
                        )
                    }
                    "payment" => res.payment = value.parse()?,
                    "cGF5bWVudA==" => {
                        let dec_str = String::from_utf8(STANDARD.decode(value)?)?;
                        // U256's from_str assumes a radix of 16, so we explicitly use from_dec_str.
                        res.payment = U256::from_dec_str(dec_str.as_str())?;
                    }
                    "gas_amount" => res.gas_amount = value.parse()?,
                    "Z2FzX2Ftb3VudA==" => {
                        let dec_str = String::from_utf8(STANDARD.decode(value)?)?;
                        // U256's from_str assumes a radix of 16, so we explicitly use from_dec_str.
                        res.gas_amount = U256::from_dec_str(dec_str.as_str())?;
                    }
                    "dest_domain" => res.destination = value.parse()?,
                    "ZGVzdF9kb21haW4=" => {
                        res.destination = String::from_utf8(STANDARD.decode(value)?)?.parse()?
                    }
                    _ => {}
                }
            }

            Ok(Some(res))
        }
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        let parser = self.get_parser();
        let result = self.indexer.get_range_event_logs(range, parser).await?;
        Ok(result)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.latest_block_height().await
    }
}

#[async_trait]
impl SequenceIndexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // TODO: implement when cosmwasm scraper support is implemented
        let tip = self.indexer.latest_block_height().await?;
        Ok((None, tip))
    }
}
