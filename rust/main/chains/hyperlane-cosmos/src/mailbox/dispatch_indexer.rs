use std::io::Cursor;
use std::ops::RangeInclusive;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use once_cell::sync::Lazy;
use tendermint::abci::EventAttribute;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Decode, HyperlaneMessage, Indexed,
    Indexer, LogMeta, SequenceAwareIndexer, H512,
};

use crate::rpc::{CosmosWasmRpcProvider, ParsedEvent, WasmRpcProvider};
use crate::utils::{
    execute_and_parse_log_futures, parse_logs_in_range, parse_logs_in_tx,
    CONTRACT_ADDRESS_ATTRIBUTE_KEY, CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64,
};
use crate::{ConnectionConf, CosmosMailbox, HyperlaneCosmosError, Signer};

/// The message dispatch event type from the CW contract.
pub const MESSAGE_DISPATCH_EVENT_TYPE: &str = "mailbox_dispatch";
const MESSAGE_ATTRIBUTE_KEY: &str = "message";
static MESSAGE_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(MESSAGE_ATTRIBUTE_KEY));

/// Struct that retrieves event data for a Cosmos Mailbox contract
#[derive(Debug, Clone)]
pub struct CosmosMailboxDispatchIndexer {
    mailbox: CosmosMailbox,
    provider: Box<CosmosWasmRpcProvider>,
}

impl CosmosMailboxDispatchIndexer {
    /// Create a reference to a mailbox at a specific Cosmos address on some
    /// chain
    pub fn new(wasm_provider: CosmosWasmRpcProvider, mailbox: CosmosMailbox) -> ChainResult<Self> {
        Ok(Self {
            mailbox,
            provider: Box::new(wasm_provider),
        })
    }

    #[instrument(err)]
    fn hyperlane_message_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<ParsedEvent<HyperlaneMessage>> {
        let mut contract_address: Option<String> = None;
        let mut message: Option<HyperlaneMessage> = None;

        for attr in attrs {
            match attr {
                EventAttribute::V037(a) => {
                    let key = a.key.as_str();
                    let value = a.value.as_str();

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

                EventAttribute::V034(a) => {
                    unimplemented!();
                }
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
impl Indexer<HyperlaneMessage> for CosmosMailboxDispatchIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let logs_futures = parse_logs_in_range(
            range,
            self.provider.clone(),
            Self::hyperlane_message_parser,
            "HyperlaneMessageCursor",
        );

        execute_and_parse_log_futures(logs_futures).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block_number().await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        parse_logs_in_tx(
            &tx_hash.into(),
            self.provider.clone(),
            Self::hyperlane_message_parser,
            "HyperlaneMessageReceiver",
        )
        .await
        .map(|v| v.into_iter().map(|(m, l)| (m.into(), l)).collect())
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for CosmosMailboxDispatchIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(&self).await?;

        let sequence = self.mailbox.nonce_at_block(tip.into()).await?;

        Ok((Some(sequence), tip))
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::HyperlaneMessage;

    use crate::providers::rpc::ParsedEvent;
    use crate::utils::event_attributes_from_str;

    use super::*;

    #[test]
    fn test_hyperlane_message_parser() {
        // Examples from https://rpc-kralum.neutron-1.neutron.org/tx_search?query=%22tx.height%20%3E=%204000000%20AND%20tx.height%20%3C=%204100000%20AND%20wasm-mailbox_dispatch._contract_address%20=%20%27neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4%27%22&prove=false&page=1&per_page=100

        let expected = ParsedEvent::new(
            "neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4".into(),
            HyperlaneMessage::from(hex::decode("03000000006e74726e0000000000000000000000006ba6343a09a60ac048d0e99f50b76fd99eff1063000000a9000000000000000000000000281973b53c9aacec128ac964a6f750fea40912aa48656c6c6f2066726f6d204e657574726f6e204d61696e6e657420746f204d616e74612050616369666963206f63742032392c2031323a353520616d").unwrap()),
        );

        let assert_parsed_event = |attrs: &Vec<EventAttribute>| {
            let parsed_event =
                CosmosMailboxDispatchIndexer::hyperlane_message_parser(attrs).unwrap();

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
