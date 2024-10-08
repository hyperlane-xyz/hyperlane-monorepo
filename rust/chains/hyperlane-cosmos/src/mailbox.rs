use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{
    fmt::{Debug, Formatter},
    io::Cursor,
    num::NonZeroU64,
    ops::RangeInclusive,
    str::FromStr,
};

use crate::payloads::{general, mailbox};
use crate::rpc::{CosmosWasmIndexer, ParsedEvent, WasmIndexer};
use crate::CosmosProvider;
use crate::{
    address::CosmosAddress,
    payloads::mailbox::{GeneralMailboxQuery, ProcessMessageRequest, ProcessMessageRequestInner},
    utils::execute_and_parse_log_futures,
};
use crate::{grpc::WasmProvider, HyperlaneCosmosError};
use crate::{signers::Signer, utils::get_block_height_for_lag, ConnectionConf};
use async_trait::async_trait;
use cosmrs::proto::cosmos::base::abci::v1beta1::TxResponse;
use once_cell::sync::Lazy;
use tendermint::abci::EventAttribute;

use crate::utils::{CONTRACT_ADDRESS_ATTRIBUTE_KEY, CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64};
use hyperlane_core::{
    utils::bytes_to_hex, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta, Mailbox, TxCostEstimate,
    TxOutcome, H256, U256,
};
use hyperlane_core::{
    ChainCommunicationError, ContractLocator, Decode, RawHyperlaneMessage, SequenceAwareIndexer,
};
use tracing::{instrument, warn};

#[derive(Clone)]
/// A reference to a Mailbox contract on some Cosmos chain
pub struct CosmosMailbox {
    config: ConnectionConf,
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider,
}

impl CosmosMailbox {
    /// Create a new cosmos mailbox
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = CosmosProvider::new(
            locator.domain.clone(),
            conf.clone(),
            Some(locator.clone()),
            signer,
        )?;

        Ok(Self {
            config: conf,
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }

    /// Prefix used in the bech32 address encoding
    pub fn bech32_prefix(&self) -> String {
        self.config.get_bech32_prefix()
    }

    fn contract_address_bytes(&self) -> usize {
        self.config.get_contract_address_bytes()
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
        Box::new(self.provider.clone())
    }
}

impl Debug for CosmosMailbox {
    fn fmt(&self, f: &mut Formatter) -> std::fmt::Result {
        todo!()
    }
}

#[async_trait]
impl Mailbox for CosmosMailbox {
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count(&self, lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let block_height = get_block_height_for_lag(self.provider.grpc(), lag).await?;
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
            .grpc()
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
            .grpc()
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, None)
            .await?;
        let response: mailbox::DefaultIsmResponse = serde_json::from_slice(&data)?;

        // convert bech32 to H256
        let ism = CosmosAddress::from_str(&response.default_ism)?;
        Ok(ism.digest())
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let address = CosmosAddress::from_h256(
            recipient,
            &self.bech32_prefix(),
            self.contract_address_bytes(),
        )?
        .address();

        let payload = mailbox::RecipientIsmRequest {
            recipient_ism: mailbox::RecipientIsmRequestInner {
                recipient_addr: address,
            },
        };

        let data = self
            .provider
            .grpc()
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, None)
            .await?;
        let response: mailbox::RecipientIsmResponse = serde_json::from_slice(&data)?;

        // convert bech32 to H256
        let ism = CosmosAddress::from_str(&response.ism)?;
        Ok(ism.digest())
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
            .grpc()
            .wasm_send(process_message, tx_gas_limit)
            .await?;

        Ok(response.try_into()?)
    }

    #[instrument(err, ret, skip(self), fields(msg=%message, metadata=%bytes_to_hex(metadata)))]
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

        let gas_limit = self
            .provider
            .grpc()
            .wasm_estimate_gas(process_message)
            .await?;

        let result = TxCostEstimate {
            gas_limit: gas_limit.into(),
            gas_price: self.provider.grpc().gas_price(),
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
            .grpc()
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, block_height)
            .await?;

        let response: mailbox::NonceResponse = serde_json::from_slice(&data)?;

        Ok(response.nonce)
    }
}

// ------------------ Indexer ------------------

const MESSAGE_ATTRIBUTE_KEY: &str = "message";
static MESSAGE_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(MESSAGE_ATTRIBUTE_KEY));

/// Struct that retrieves event data for a Cosmos Mailbox contract
#[derive(Debug, Clone)]
pub struct CosmosMailboxIndexer {
    mailbox: CosmosMailbox,
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosMailboxIndexer {
    /// The message dispatch event type from the CW contract.
    const MESSAGE_DISPATCH_EVENT_TYPE: &str = "mailbox_dispatch";

    /// Create a reference to a mailbox at a specific Cosmos address on some
    /// chain
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
        reorg_period: u32,
    ) -> ChainResult<Self> {
        let mailbox = CosmosMailbox::new(conf.clone(), locator.clone(), signer.clone())?;
        let indexer = CosmosWasmIndexer::new(
            conf,
            locator,
            Self::MESSAGE_DISPATCH_EVENT_TYPE.into(),
            reorg_period,
        )?;

        Ok(Self {
            mailbox,
            indexer: Box::new(indexer),
        })
    }

    #[instrument(err)]
    fn hyperlane_message_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<ParsedEvent<HyperlaneMessage>> {
        let mut contract_address: Option<String> = None;
        let mut message: Option<HyperlaneMessage> = None;

        for attr in attrs {
            let key = attr.key.as_str();
            let value = attr.value.as_str();

            match key {
                CONTRACT_ADDRESS_ATTRIBUTE_KEY => {
                    contract_address = Some(value.to_string());
                }
                v if *CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64 == v => {
                    contract_address = Some(String::from_utf8(
                        BASE64
                            .decode(value)
                            .map_err(Into::<HyperlaneCosmosError>::into)?,
                    )?);
                }

                MESSAGE_ATTRIBUTE_KEY => {
                    // Intentionally using read_from to get a Result::Err if there's
                    // an issue with the message.
                    let mut reader = Cursor::new(hex::decode(value)?);
                    message = Some(HyperlaneMessage::read_from(&mut reader)?);
                }
                v if *MESSAGE_ATTRIBUTE_KEY_BASE64 == v => {
                    // Intentionally using read_from to get a Result::Err if there's
                    // an issue with the message.
                    let mut reader = Cursor::new(hex::decode(String::from_utf8(
                        BASE64
                            .decode(value)
                            .map_err(Into::<HyperlaneCosmosError>::into)?,
                    )?)?);
                    message = Some(HyperlaneMessage::read_from(&mut reader)?);
                }

                _ => {}
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;
        let message =
            message.ok_or_else(|| ChainCommunicationError::from_other_str("missing message"))?;

        Ok(ParsedEvent::new(contract_address, message))
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for CosmosMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let logs_futures: Vec<_> = range
            .map(|block_number| {
                let self_clone = self.clone();
                tokio::spawn(async move {
                    let logs = self_clone
                        .indexer
                        .get_logs_in_block(
                            block_number,
                            Self::hyperlane_message_parser,
                            "HyperlaneMessageCursor",
                        )
                        .await;
                    (logs, block_number)
                })
            })
            .collect();

        execute_and_parse_log_futures(logs_futures).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl Indexer<H256> for CosmosMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        // TODO: implement when implementing Cosmos scraping
        todo!()
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for CosmosMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<H256>::get_finalized_block_number(&self).await?;

        // No sequence for message deliveries.
        Ok((None, tip))
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for CosmosMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(&self).await?;

        let sequence = self.mailbox.nonce_at_block(Some(tip.into())).await?;

        Ok((Some(sequence), tip))
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::HyperlaneMessage;

    use crate::{rpc::ParsedEvent, utils::event_attributes_from_str};

    use super::*;

    #[test]
    fn test_hyperlane_message_parser() {
        // Examples from https://rpc-kralum.neutron-1.neutron.org/tx_search?query=%22tx.height%20%3E=%204000000%20AND%20tx.height%20%3C=%204100000%20AND%20wasm-mailbox_dispatch._contract_address%20=%20%27neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4%27%22&prove=false&page=1&per_page=100

        let expected = ParsedEvent::new(
            "neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4".into(),
            HyperlaneMessage::from(hex::decode("03000000006e74726e0000000000000000000000006ba6343a09a60ac048d0e99f50b76fd99eff1063000000a9000000000000000000000000281973b53c9aacec128ac964a6f750fea40912aa48656c6c6f2066726f6d204e657574726f6e204d61696e6e657420746f204d616e74612050616369666963206f63742032392c2031323a353520616d").unwrap()),
        );

        let assert_parsed_event = |attrs: &Vec<EventAttribute>| {
            let parsed_event = CosmosMailboxIndexer::hyperlane_message_parser(attrs).unwrap();

            assert_eq!(parsed_event, expected);
        };

        // Non-base64 version
        let non_base64_attrs = event_attributes_from_str(
            r#"[{"key":"_contract_address","value":"neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4","index":true},{"key":"sender","value":"0000000000000000000000006ba6343a09a60ac048d0e99f50b76fd99eff1063","index":true},{"key":"destination","value":"169","index":true},{"key":"recipient","value":"000000000000000000000000281973b53c9aacec128ac964a6f750fea40912aa","index":true},{"key":"message","value":"03000000006e74726e0000000000000000000000006ba6343a09a60ac048d0e99f50b76fd99eff1063000000a9000000000000000000000000281973b53c9aacec128ac964a6f750fea40912aa48656c6c6f2066726f6d204e657574726f6e204d61696e6e657420746f204d616e74612050616369666963206f63742032392c2031323a353520616d","index":true}]"#,
        );
        assert_parsed_event(&non_base64_attrs);

        // Base64 version
        let base64_attrs = event_attributes_from_str(
            r#"[{"key":"X2NvbnRyYWN0X2FkZHJlc3M=","value":"bmV1dHJvbjFzanp6ZDRnd2tnZ3k2aHJyczhreHhhdGV4emN1ejNqZWNzeG0zd3FncmVna3Vsemo4cjdxbG51ZWY0","index":true},{"key":"c2VuZGVy","value":"MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNmJhNjM0M2EwOWE2MGFjMDQ4ZDBlOTlmNTBiNzZmZDk5ZWZmMTA2Mw==","index":true},{"key":"ZGVzdGluYXRpb24=","value":"MTY5","index":true},{"key":"cmVjaXBpZW50","value":"MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMjgxOTczYjUzYzlhYWNlYzEyOGFjOTY0YTZmNzUwZmVhNDA5MTJhYQ==","index":true},{"key":"bWVzc2FnZQ==","value":"MDMwMDAwMDAwMDZlNzQ3MjZlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNmJhNjM0M2EwOWE2MGFjMDQ4ZDBlOTlmNTBiNzZmZDk5ZWZmMTA2MzAwMDAwMGE5MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMjgxOTczYjUzYzlhYWNlYzEyOGFjOTY0YTZmNzUwZmVhNDA5MTJhYTQ4NjU2YzZjNmYyMDY2NzI2ZjZkMjA0ZTY1NzU3NDcyNmY2ZTIwNGQ2MTY5NmU2ZTY1NzQyMDc0NmYyMDRkNjE2ZTc0NjEyMDUwNjE2MzY5NjY2OTYzMjA2ZjYzNzQyMDMyMzkyYzIwMzEzMjNhMzUzNTIwNjE2ZA==","index":true}]"#,
        );
        assert_parsed_event(&base64_attrs);
    }
}
