use std::ops::RangeInclusive;

use async_trait::async_trait;
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, Indexer,
    InterchainGasPaymaster, U256,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneProvider, InterchainGasPayment, LogMeta, H256};

use crate::rpc::{CosmosWasmIndexer, WasmIndexer};
use crate::signers::Signer;
use crate::verify::bech32_decode;
use crate::ConnectionConf;

/// A reference to a InterchainGasPaymaster contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymaster {
    domain: HyperlaneDomain,
    address: String,
}

impl HyperlaneContract for CosmosInterchainGasPaymaster {
    fn address(&self) -> H256 {
        bech32_decode(self.address.clone())
    }
}

impl HyperlaneChain for CosmosInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

impl InterchainGasPaymaster for CosmosInterchainGasPaymaster {}

impl CosmosInterchainGasPaymaster {
    /// create new Cosmos InterchainGasPaymaster agent
    pub fn new(domain: HyperlaneDomain, address: String) -> Self {
        Self { domain, address }
    }
}

/// A reference to a InterchainGasPaymasterIndexer contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymasterIndexer<'a> {
    conf: &'a ConnectionConf,
    locator: &'a ContractLocator<'a>,
    signer: &'a Signer,
    event_type: String,
    indexer: Box<CosmosWasmIndexer<'a>>,
}

impl<'a> CosmosInterchainGasPaymasterIndexer<'a> {
    /// create new Cosmos InterchainGasPaymasterIndexer agent
    pub fn new(
        conf: &'a ConnectionConf,
        locator: &'a ContractLocator,
        signer: &'a Signer,
        event_type: String,
    ) -> Self {
        let indexer: CosmosWasmIndexer<'_> =
            CosmosWasmIndexer::new(conf, locator, signer, event_type.clone());

        Self {
            conf,
            locator,
            signer,
            event_type,
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
