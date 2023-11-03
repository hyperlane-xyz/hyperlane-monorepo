use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{
    unwrap_or_none_result, HyperlaneDomain, HyperlaneProvider, InterchainGasPayment, LogMeta, H256,
};
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, Indexer,
    InterchainGasPaymaster, SequenceIndexer, U256,
};
use std::ops::RangeInclusive;

use crate::{
    grpc::WasmGrpcProvider,
    rpc::{CosmosWasmIndexer, ParsedEvent, WasmIndexer},
    signers::Signer,
    utils::{CONTRACT_ADDRESS_ATTRIBUTE_KEY, CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64},
    ConnectionConf, CosmosProvider,
};
use tracing::debug;

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

// ------------------ Indexer ------------------

const MESSAGE_ID_ATTRIBUTE_KEY: &str = "message_id";
// echo -n message_id | base64
const MESSAGE_ID_ATTRIBUTE_KEY_BASE64: &str = "bWVzc2FnZV9pZA==";

const PAYMENT_ATTRIBUTE_KEY: &str = "payment";
// echo -n payment | base64
const PAYMENT_ATTRIBUTE_KEY_BASE64: &str = "cGF5bWVudA==";

const GAS_AMOUNT_ATTRIBUTE_KEY: &str = "gas_amount";
// echo -n gas_amount | base64
const GAS_AMOUNT_ATTRIBUTE_KEY_BASE64: &str = "Z2FzX2Ftb3VudA==";

const DESTINATION_ATTRIBUTE_KEY: &str = "dest_domain";
// echo -n dest_domain | base64
const DESTINATION_ATTRIBUTE_KEY_BASE64: &str = "ZGVzdF9kb21haW4=";

/// A reference to a InterchainGasPaymasterIndexer contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymasterIndexer {
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosInterchainGasPaymasterIndexer {
    /// create new Cosmos InterchainGasPaymasterIndexer agent
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        event_type: String,
        reorg_period: u32,
    ) -> ChainResult<Self> {
        let indexer = CosmosWasmIndexer::new(conf, locator, event_type.clone(), reorg_period)?;

        Ok(Self {
            indexer: Box::new(indexer),
        })
    }

    fn interchain_gas_payment_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<Option<ParsedEvent<InterchainGasPayment>>> {
        let mut contract_address: Option<String> = None;
        let mut message_id: Option<H256> = None;
        let mut payment: Option<U256> = None;
        let mut gas_amount: Option<U256> = None;
        let mut destination: Option<u32> = None;

        for attr in attrs {
            let key = attr.key.as_str();
            let value = attr.value.as_str();

            match key {
                CONTRACT_ADDRESS_ATTRIBUTE_KEY => {
                    contract_address = Some(value.to_string());
                }
                CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64 => {
                    contract_address = Some(String::from_utf8(BASE64.decode(value)?)?);
                }

                MESSAGE_ID_ATTRIBUTE_KEY => {
                    message_id = Some(H256::from_slice(hex::decode(value)?.as_slice()));
                }
                MESSAGE_ID_ATTRIBUTE_KEY_BASE64 => {
                    message_id = Some(H256::from_slice(
                        hex::decode(String::from_utf8(BASE64.decode(value)?)?)?.as_slice(),
                    ));
                }

                PAYMENT_ATTRIBUTE_KEY => {
                    payment = Some(value.parse()?);
                }
                PAYMENT_ATTRIBUTE_KEY_BASE64 => {
                    let dec_str = String::from_utf8(BASE64.decode(value)?)?;
                    // U256's from_str assumes a radix of 16, so we explicitly use from_dec_str.
                    payment = Some(U256::from_dec_str(dec_str.as_str())?);
                }

                GAS_AMOUNT_ATTRIBUTE_KEY => {
                    gas_amount = Some(value.parse()?);
                }
                GAS_AMOUNT_ATTRIBUTE_KEY_BASE64 => {
                    let dec_str = String::from_utf8(BASE64.decode(value)?)?;
                    // U256's from_str assumes a radix of 16, so we explicitly use from_dec_str.
                    gas_amount = Some(U256::from_dec_str(dec_str.as_str())?);
                }

                DESTINATION_ATTRIBUTE_KEY => {
                    destination = Some(value.parse::<u32>()?);
                }
                DESTINATION_ATTRIBUTE_KEY_BASE64 => {
                    destination = Some(String::from_utf8(BASE64.decode(value)?)?.parse()?);
                }

                _ => {}
            }
        }

        let contract_address = unwrap_or_none_result!(
            contract_address,
            debug!("No contract address found in event attributes")
        );
        let message_id = unwrap_or_none_result!(
            message_id,
            debug!("No message ID found in event attributes")
        );

        let payment =
            unwrap_or_none_result!(payment, debug!("No payment found in event attributes"));

        let gas_amount = unwrap_or_none_result!(
            gas_amount,
            debug!("No gas_amount found in event attributes")
        );

        let destination = unwrap_or_none_result!(
            destination,
            debug!("No destination found in event attributes")
        );

        Ok(Some(ParsedEvent::new(
            contract_address,
            InterchainGasPayment {
                message_id,
                payment,
                gas_amount,
                destination,
            },
        )))
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        let result = self
            .indexer
            .get_range_event_logs(range, Self::interchain_gas_payment_parser)
            .await?;
        Ok(result)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceIndexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // TODO: implement when cosmwasm scraper support is implemented
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}
