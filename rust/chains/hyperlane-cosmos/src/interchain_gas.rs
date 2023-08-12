use async_trait::async_trait;
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, Indexer,
    InterchainGasPaymaster, U256,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneProvider, InterchainGasPayment, LogMeta, H256};
use std::ops::RangeInclusive;

use crate::grpc::{WasmGrpcProvider, WasmProvider};
use crate::rpc::{CosmosWasmIndexer, WasmIndexer};
use crate::signers::Signer;
use crate::ConnectionConf;

/// A reference to a InterchainGasPaymaster contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymaster<'a> {
    _conf: &'a ConnectionConf,
    locator: &'a ContractLocator<'a>,
    _signer: &'a Signer,
    _provider: Box<WasmGrpcProvider<'a>>,
}

impl HyperlaneContract for CosmosInterchainGasPaymaster<'_> {
    fn address(&self) -> H256 {
        self.locator.address
    }
}

impl HyperlaneChain for CosmosInterchainGasPaymaster<'_> {
    fn domain(&self) -> &HyperlaneDomain {
        self.locator.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

impl InterchainGasPaymaster for CosmosInterchainGasPaymaster<'_> {}

impl<'a> CosmosInterchainGasPaymaster<'a> {
    /// create new Cosmos InterchainGasPaymaster agent
    pub fn new(conf: &'a ConnectionConf, locator: &'a ContractLocator, signer: &'a Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf, locator, signer);

        Self {
            _conf: conf,
            locator,
            _signer: signer,
            _provider: Box::new(provider),
        }
    }
}

/// A reference to a InterchainGasPaymasterIndexer contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymasterIndexer<'a> {
    indexer: Box<CosmosWasmIndexer<'a>>,
}

impl<'a> CosmosInterchainGasPaymasterIndexer<'a> {
    /// create new Cosmos InterchainGasPaymasterIndexer agent
    pub fn new(conf: &'a ConnectionConf, locator: &'a ContractLocator, event_type: String) -> Self {
        let indexer: CosmosWasmIndexer<'_> =
            CosmosWasmIndexer::new(conf, locator, event_type.clone());

        Self {
            indexer: Box::new(indexer),
        }
    }

    fn get_parser(&self) -> fn(attrs: Vec<EventAttribute>) -> InterchainGasPayment {
        |attrs: Vec<EventAttribute>| -> InterchainGasPayment {
            let mut res = InterchainGasPayment {
                message_id: H256::zero(),
                payment: U256::zero(),
                gas_amount: U256::zero(),
            };

            for attr in attrs {
                let key = attr.key.as_str();
                let value = attr.value.as_str();

                match key {
                    "message_id" => {
                        res.message_id = H256::from_slice(hex::decode(value).unwrap().as_slice())
                    }
                    "payment" => res.payment = value.parse().unwrap(),
                    "gas_amount" => res.gas_amount = value.parse().unwrap(),
                    _ => {}
                }
            }

            res
        }
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer<'_> {
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        let mut result: Vec<(InterchainGasPayment, LogMeta)> = vec![];
        let parser = self.get_parser();

        for block_number in range {
            let logs = self.indexer.get_event_log(block_number, parser).await?;
            result.extend(logs);
        }

        Ok(result)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.latest_block_height().await
    }
}
