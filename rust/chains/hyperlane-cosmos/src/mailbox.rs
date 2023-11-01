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
use crate::{signers::Signer, utils::get_block_height_for_lag, verify, ConnectionConf};
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
use hyperlane_core::{
    ChainCommunicationError, ContractLocator, Decode, RawHyperlaneMessage, SequenceIndexer,
};
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
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

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
        let block_height = get_block_height_for_lag(&self.provider, lag).await?;
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
        let ism = verify::bech32_decode(response.ism)?;
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
                hex::decode(response.txhash)?.as_slice(),
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
            gas_limit: U256::from(
                response
                    .gas_info
                    .ok_or(ChainCommunicationError::TxCostEstimateError(
                        "Failed to estimate gas limit".to_string(),
                    ))?
                    .gas_used,
            ),
            gas_price: U256::from(2500),
            l2_gas_limit: None,
        };

        Ok(result)
    }

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        todo!() // not required
    }
}

impl CosmosMailbox {
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

/// Struct that retrieves event data for a Cosmos Mailbox contract
#[derive(Debug)]
pub struct CosmosMailboxIndexer {
    mailbox: CosmosMailbox,
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosMailboxIndexer {
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Signer,
        event_type: String,
        reorg_period: u32,
    ) -> ChainResult<Self> {
        let mailbox = CosmosMailbox::new(conf.clone(), locator.clone(), signer.clone());
        let indexer = CosmosWasmIndexer::new(conf, locator, event_type, reorg_period)?;

        Ok(Self {
            mailbox,
            indexer: Box::new(indexer),
        })
    }

    fn get_parser(
        &self,
    ) -> fn(attrs: &Vec<EventAttribute>) -> ChainResult<Option<HyperlaneMessage>> {
        |attrs: &Vec<EventAttribute>| -> ChainResult<Option<HyperlaneMessage>> {
            let res = HyperlaneMessage::default();

            for attr in attrs {
                let key = attr.key.as_str();
                let value = attr.value.as_str();

                if key == "message" {
                    let mut reader = Cursor::new(hex::decode(value)?);
                    return Ok(Some(HyperlaneMessage::read_from(&mut reader)?));
                }

                if key == "bWVzc2FnZQ==" {
                    let mut reader = Cursor::new(hex::decode(String::from_utf8(
                        base64::engine::general_purpose::STANDARD.decode(value)?,
                    )?)?);
                    return Ok(Some(HyperlaneMessage::read_from(&mut reader)?));
                }
            }
            Ok(None)
        }
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
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl Indexer<H256> for CosmosMailboxIndexer {
    async fn fetch_logs(&self, range: RangeInclusive<u32>) -> ChainResult<Vec<(H256, LogMeta)>> {
        let parser = self.get_parser();
        let result = self.indexer.get_range_event_logs(range, parser).await?;

        Ok(result
            .into_iter()
            .map(|(msg, meta)| (msg.id(), meta))
            .collect())
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceIndexer<H256> for CosmosMailboxIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<H256>::get_finalized_block_number(&self).await?;

        // No sequence for message deliveries.
        Ok((None, tip))
    }
}

#[async_trait]
impl SequenceIndexer<HyperlaneMessage> for CosmosMailboxIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(&self).await?;

        let sequence = self.mailbox.nonce_at_block(Some(tip.into())).await?;

        Ok((Some(sequence), tip))
    }
}
