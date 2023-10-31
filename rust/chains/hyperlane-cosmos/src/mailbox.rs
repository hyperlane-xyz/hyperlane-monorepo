use base64::Engine;
use std::fmt::{Debug, Formatter};
use std::io::Cursor;
use std::num::NonZeroU64;
use std::ops::RangeInclusive;

use crate::grpc::{WasmGrpcProvider, WasmProvider};
use crate::payloads::mailbox::{
    GeneralMailboxQuery, ProcessMessageRequest, ProcessMessageRequestInner,
};
use crate::payloads::{general, mailbox};
use crate::rpc::{CosmosWasmIndexer, WasmIndexer};
use crate::CosmosProvider;
use crate::{signers::Signer, verify, ConnectionConf};
use async_trait::async_trait;

use cosmrs::proto::cosmos::base::abci::v1beta1::TxResponse;
use cosmrs::proto::cosmos::tx::v1beta1::SimulateResponse;
use cosmrs::tendermint::abci::EventAttribute;

use crate::binary::h256_to_h512;
use hyperlane_core::{
    utils::fmt_bytes, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Indexer, LogMeta, Mailbox, TxCostEstimate, TxOutcome,
    H256, U256,
};
use hyperlane_core::{ContractLocator, Decode, RawHyperlaneMessage, SequenceIndexer};
use tracing::{instrument, warn};

/// A reference to a Mailbox contract on some Cosmos chain
pub struct CosmosMailbox {
    _conf: ConnectionConf,
    domain: HyperlaneDomain,
    address: H256,
    signer: Signer,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosMailbox {
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(conf: ConnectionConf, locator: ContractLocator, signer: Signer) -> Self {
        let provider: WasmGrpcProvider =
            WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

        Self {
            _conf: conf,
            domain: locator.domain.clone(),
            address: locator.address,
            signer,
            provider: Box::new(provider),
        }
    }
}

impl HyperlaneContract for CosmosMailbox {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(CosmosProvider::new(self.domain.clone()))
    }
}

impl Debug for CosmosMailbox {
    fn fmt(&self, f: &mut Formatter) -> std::fmt::Result {
        // Debug::fmt(&(self as &dyn HyperlaneContract), f)
        todo!()
    }
}

#[async_trait]
impl Mailbox for CosmosMailbox {
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count(&self, lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let block_height = self.get_block_height_for_lag(lag).await?;
        self.nonce_at_block(block_height).await
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let id = hex::encode(id);
        let payload = mailbox::DeliveredRequest {
            message_delivered: mailbox::DeliveredRequestInner { id },
        };

        let delivered = match self
            .provider
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, None)
            .await
        {
            Ok(v) => {
                let response: mailbox::DeliveredResponse = serde_json::from_slice(&v)?;

                response.delivered
            }
            Err(err) => {
                warn!(
                    "error while checking the message delivery status: {:?}",
                    err
                );

                false
            }
        };

        Ok(delivered)
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        let payload = mailbox::DefaultIsmRequest {
            default_ism: general::EmptyStruct {},
        };

        let data = self
            .provider
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, None)
            .await?;
        let response: mailbox::DefaultIsmResponse = serde_json::from_slice(&data)?;

        // convert Hex to H256
        let ism = H256::from_slice(&hex::decode(response.default_ism)?);
        Ok(ism)
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let address = verify::digest_to_addr(recipient, &self.signer.prefix)?;

        let payload = mailbox::RecipientIsmRequest {
            recipient_ism: mailbox::RecipientIsmRequestInner {
                recipient_addr: address,
            },
        };

        let data = self
            .provider
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, None)
            .await?;
        let response: mailbox::RecipientIsmResponse = serde_json::from_slice(&data)?;

        // convert Hex to H256
        let ism = verify::bech32_decode(response.ism);
        Ok(ism)
    }

    #[instrument(err, ret, skip(self))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let process_message = ProcessMessageRequest {
            process: ProcessMessageRequestInner {
                message: hex::encode(RawHyperlaneMessage::from(message)),
                metadata: hex::encode(metadata),
            },
        };

        let response: TxResponse = self
            .provider
            .wasm_send(process_message, tx_gas_limit)
            .await?;
        Ok(TxOutcome {
            transaction_id: h256_to_h512(H256::from_slice(
                hex::decode(response.txhash).unwrap().as_slice(),
            )),
            executed: response.code == 0,
            gas_used: U256::from(response.gas_used),
            gas_price: U256::from(response.gas_wanted),
        })
    }

    #[instrument(err, ret, skip(self), fields(msg=%message, metadata=%fmt_bytes(metadata)))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let process_message = ProcessMessageRequest {
            process: ProcessMessageRequestInner {
                message: hex::encode(RawHyperlaneMessage::from(message)),
                metadata: hex::encode(metadata),
            },
        };

        let response: SimulateResponse = self.provider.wasm_simulate(process_message).await?;
        let result = TxCostEstimate {
            gas_limit: U256::from(response.gas_info.unwrap().gas_used),
            gas_price: U256::from(2500),
            l2_gas_limit: None,
        };

        Ok(result)
    }

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        todo!() // not required
    }
}

/// Struct that retrieves event data for a Cosmos Mailbox contract
#[derive(Debug)]
pub struct CosmosMailboxIndexer {
    indexer: Box<CosmosWasmIndexer>,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosMailboxIndexer {
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Signer,
        event_type: String,
    ) -> Self {
        let indexer: CosmosWasmIndexer =
            CosmosWasmIndexer::new(conf.clone(), locator.clone(), event_type.clone());
        let provider: WasmGrpcProvider = WasmGrpcProvider::new(conf, locator, signer);

        Self {
            indexer: Box::new(indexer),
            provider: Box::new(provider),
        }
    }

    fn get_parser(&self) -> fn(attrs: Vec<EventAttribute>) -> Option<HyperlaneMessage> {
        |attrs: Vec<EventAttribute>| -> Option<HyperlaneMessage> {
            let mut res = HyperlaneMessage::default();

            for attr in attrs {
                let key = attr.key.as_str();
                let value = attr.value;
                let value = value.as_str();

                if key == "message" {
                    let mut reader = Cursor::new(hex::decode(value).unwrap());
                    return Some(HyperlaneMessage::read_from(&mut reader).unwrap());
                }

                if key == "bWVzc2FnZQ==" {
                    let mut reader = Cursor::new(
                        hex::decode(
                            String::from_utf8(
                                base64::engine::general_purpose::STANDARD
                                    .decode(value)
                                    .unwrap(),
                            )
                            .unwrap(),
                        )
                        .unwrap(),
                    );
                    return Some(HyperlaneMessage::read_from(&mut reader).unwrap());
                }
            }
            None
        }
    }

    /// Given a lag, returns the block height at the moment.
    /// If the lag is None, a block height of None is given, indicating that the
    /// tip directly can be used.
    async fn get_block_height_for_lag(&self, lag: Option<NonZeroU64>) -> ChainResult<Option<u64>> {
        let block_height = match lag {
            Some(lag) => {
                let tip = self.indexer.latest_block_height().await?;
                let block_height = tip as u64 - lag;
                Some(block_height)
            }
            None => None,
        };

        Ok(block_height)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn nonce_at_block(&self, block_height: Option<u64>) -> ChainResult<u32> {
        let payload = mailbox::NonceRequest {
            nonce: general::EmptyStruct {},
        };

        let data = self
            .provider
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, block_height)
            .await?;

        let response: mailbox::NonceResponse = serde_json::from_slice(&data)?;

        Ok(response.nonce)
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for CosmosMailboxIndexer {
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        let parser = self.get_parser();
        let result = self.indexer.get_range_event_logs(range, parser).await?;

        Ok(result)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.latest_block_height().await
    }
}

#[async_trait]
impl Indexer<H256> for CosmosMailboxIndexer {
    async fn fetch_logs(&self, range: RangeInclusive<u32>) -> ChainResult<Vec<(H256, LogMeta)>> {
        let parser: fn(Vec<EventAttribute>) -> Option<HyperlaneMessage> = self.get_parser();
        let result = self.indexer.get_range_event_logs(range, parser).await?;

        Ok(result
            .into_iter()
            .map(|(msg, meta)| (msg.id(), meta))
            .collect())
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.latest_block_height().await
    }
}

#[async_trait]
impl SequenceIndexer<H256> for CosmosMailboxIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.indexer.latest_block_height().await?;

        // No sequence for message deliveries.
        Ok((None, tip))
    }
}

#[async_trait]
impl SequenceIndexer<HyperlaneMessage> for CosmosMailboxIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.indexer.latest_block_height().await?;

        let sequence = self.nonce_at_block(Some(tip)).await?;

        Ok((sequence, tip))
    }
}
