use async_trait::async_trait;
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, Indexer,
    InterchainGasPaymaster, SequenceIndexer, U256,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneProvider, InterchainGasPayment, LogMeta, H256};
use std::ops::RangeInclusive;
use tracing::info;

use crate::grpc::WasmGrpcProvider;
use crate::rpc::{CosmosWasmIndexer, WasmIndexer};
use crate::signers::Signer;
use crate::ConnectionConf;

/// A reference to a InterchainGasPaymaster contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymaster {
    _conf: ConnectionConf,
    domain: HyperlaneDomain,
    address: H256,
    _signer: Signer,
    _provider: Box<WasmGrpcProvider>,
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
        todo!()
    }
}

impl InterchainGasPaymaster for CosmosInterchainGasPaymaster {}

impl CosmosInterchainGasPaymaster {
    /// create new Cosmos InterchainGasPaymaster agent
    pub fn new(conf: ConnectionConf, locator: ContractLocator, signer: Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

        Self {
            _conf: conf,
            domain: locator.domain.clone(),
            address: locator.address,
            _signer: signer,
            _provider: Box::new(provider),
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
impl Indexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
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

#[async_trait]
impl Indexer<H256> for CosmosInterchainGasPaymasterIndexer {
    async fn fetch_logs(&self, range: RangeInclusive<u32>) -> ChainResult<Vec<(H256, LogMeta)>> {
        let mut result: Vec<(InterchainGasPayment, LogMeta)> = vec![];
        let parser = self.get_parser();

        for block_number in range {
            let logs = self.indexer.get_event_log(block_number, parser).await?;
            result.extend(logs);
        }

        Ok(result
            .into_iter()
            .map(|(msg, meta)| (msg.message_id, meta))
            .collect())
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.latest_block_height().await
    }
}

#[async_trait]
impl SequenceIndexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
    async fn sequence_at_tip(&self) -> ChainResult<(u32, u32)> {
        // TODO: implement when sealevel scraper support is implemented
        info!("Message delivery indexing not implemented");
        Ok((1, 1))
    }
}

#[async_trait]
impl SequenceIndexer<H256> for CosmosInterchainGasPaymasterIndexer {
    async fn sequence_at_tip(&self) -> ChainResult<(u32, u32)> {
        // TODO: implement when sealevel scraper support is implemented
        info!("Message delivery indexing not implemented");
        Ok((1, 1))
    }
}
