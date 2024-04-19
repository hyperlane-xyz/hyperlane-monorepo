use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures::future;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, Indexer, InterchainGasPaymaster, InterchainGasPayment,
    LogMeta, SequenceAwareIndexer, H256, U256,
};
use once_cell::sync::Lazy;
use std::ops::RangeInclusive;
use tendermint::abci::EventAttribute;
use tracing::{instrument, warn};

use crate::{
    rpc::{CosmosWasmIndexer, ParsedEvent, WasmIndexer},
    signers::Signer,
    utils::{CONTRACT_ADDRESS_ATTRIBUTE_KEY, CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64},
    ConnectionConf, CosmosProvider, HyperlaneCosmosError,
};

/// A reference to a InterchainGasPaymaster contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosInterchainGasPaymaster {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider,
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
        Box::new(self.provider.clone())
    }
}

impl InterchainGasPaymaster for CosmosInterchainGasPaymaster {}

impl CosmosInterchainGasPaymaster {
    /// create new Cosmos InterchainGasPaymaster agent
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
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }
}

// ------------------ Indexer ------------------

const MESSAGE_ID_ATTRIBUTE_KEY: &str = "message_id";
static MESSAGE_ID_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(MESSAGE_ID_ATTRIBUTE_KEY));

const PAYMENT_ATTRIBUTE_KEY: &str = "payment";
static PAYMENT_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(PAYMENT_ATTRIBUTE_KEY));

const GAS_AMOUNT_ATTRIBUTE_KEY: &str = "gas_amount";
static GAS_AMOUNT_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(GAS_AMOUNT_ATTRIBUTE_KEY));

const DESTINATION_ATTRIBUTE_KEY: &str = "dest_domain";
static DESTINATION_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(DESTINATION_ATTRIBUTE_KEY));

/// A reference to a InterchainGasPaymasterIndexer contract on some Cosmos chain
#[derive(Debug, Clone)]
pub struct CosmosInterchainGasPaymasterIndexer {
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosInterchainGasPaymasterIndexer {
    /// The interchain gas payment event type from the CW contract.
    const INTERCHAIN_GAS_PAYMENT_EVENT_TYPE: &str = "igp-core-pay-for-gas";

    /// create new Cosmos InterchainGasPaymasterIndexer agent
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        reorg_period: u32,
    ) -> ChainResult<Self> {
        let indexer = CosmosWasmIndexer::new(
            conf,
            locator,
            Self::INTERCHAIN_GAS_PAYMENT_EVENT_TYPE.into(),
            reorg_period,
        )?;

        Ok(Self {
            indexer: Box::new(indexer),
        })
    }

    #[instrument(err)]
    fn interchain_gas_payment_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<ParsedEvent<InterchainGasPayment>> {
        let mut contract_address: Option<String> = None;
        let mut gas_payment = IncompleteInterchainGasPayment::default();

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

                MESSAGE_ID_ATTRIBUTE_KEY => {
                    gas_payment.message_id = Some(H256::from_slice(hex::decode(value)?.as_slice()));
                }
                v if *MESSAGE_ID_ATTRIBUTE_KEY_BASE64 == v => {
                    gas_payment.message_id = Some(H256::from_slice(
                        hex::decode(String::from_utf8(
                            BASE64
                                .decode(value)
                                .map_err(Into::<HyperlaneCosmosError>::into)?,
                        )?)?
                        .as_slice(),
                    ));
                }

                PAYMENT_ATTRIBUTE_KEY => {
                    gas_payment.payment = Some(U256::from_dec_str(value)?);
                }
                v if *PAYMENT_ATTRIBUTE_KEY_BASE64 == v => {
                    let dec_str = String::from_utf8(
                        BASE64
                            .decode(value)
                            .map_err(Into::<HyperlaneCosmosError>::into)?,
                    )?;
                    // U256's from_str assumes a radix of 16, so we explicitly use from_dec_str.
                    gas_payment.payment = Some(U256::from_dec_str(dec_str.as_str())?);
                }

                GAS_AMOUNT_ATTRIBUTE_KEY => {
                    gas_payment.gas_amount = Some(U256::from_dec_str(value)?);
                }
                v if *GAS_AMOUNT_ATTRIBUTE_KEY_BASE64 == v => {
                    let dec_str = String::from_utf8(
                        BASE64
                            .decode(value)
                            .map_err(Into::<HyperlaneCosmosError>::into)?,
                    )?;
                    // U256's from_str assumes a radix of 16, so we explicitly use from_dec_str.
                    gas_payment.gas_amount = Some(U256::from_dec_str(dec_str.as_str())?);
                }

                DESTINATION_ATTRIBUTE_KEY => {
                    gas_payment.destination = Some(value.parse::<u32>()?);
                }
                v if *DESTINATION_ATTRIBUTE_KEY_BASE64 == v => {
                    gas_payment.destination = Some(
                        String::from_utf8(
                            BASE64
                                .decode(value)
                                .map_err(Into::<HyperlaneCosmosError>::into)?,
                        )?
                        .parse()?,
                    );
                }

                _ => {}
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;

        Ok(ParsedEvent::new(contract_address, gas_payment.try_into()?))
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        let logs_futures: Vec<_> = range
            .map(|block_number| {
                let self_clone = self.clone();
                tokio::spawn(async move {
                    let logs = self_clone
                        .indexer
                        .get_logs_in_block(
                            block_number,
                            Self::interchain_gas_payment_parser,
                            "InterchainGasPaymentCursor",
                        )
                        .await;
                    (logs, block_number)
                })
            })
            .collect();

        // TODO: this can be refactored when we rework indexing, to be part of the block-by-block indexing
        let result = future::join_all(logs_futures)
            .await
            .into_iter()
            .flatten()
            .map(|(logs, block_number)| {
                if let Err(err) = &logs {
                    warn!(?err, ?block_number, "Failed to fetch logs for block");
                }
                logs
            })
            // Propagate errors from any of the queries. This will cause the entire range to be retried,
            // including successful ones, but we don't have a way to handle partial failures in a range for now.
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect();

        Ok(result)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // TODO: implement when cosmwasm scraper support is implemented
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}

#[derive(Default)]
struct IncompleteInterchainGasPayment {
    message_id: Option<H256>,
    payment: Option<U256>,
    gas_amount: Option<U256>,
    destination: Option<u32>,
}

impl TryInto<InterchainGasPayment> for IncompleteInterchainGasPayment {
    type Error = ChainCommunicationError;

    fn try_into(self) -> Result<InterchainGasPayment, Self::Error> {
        let message_id = self
            .message_id
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing message_id"))?;
        let payment = self
            .payment
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing payment"))?;
        let gas_amount = self
            .gas_amount
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing gas_amount"))?;
        let destination = self
            .destination
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing destination"))?;

        Ok(InterchainGasPayment {
            message_id,
            payment,
            gas_amount,
            destination,
        })
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::{InterchainGasPayment, H256, U256};
    use std::str::FromStr;

    use crate::{rpc::ParsedEvent, utils::event_attributes_from_str};

    use super::*;

    #[test]
    fn test_interchain_gas_payment_parser() {
        // Examples from https://rpc-kralum.neutron-1.neutron.org/tx_search?query=%22tx.height%20%3E=%204000000%20AND%20tx.height%20%3C=%204100000%20AND%20wasm-igp-core-pay-for-gas._contract_address%20=%20%27neutron12p8wntzra3vpfcqv05scdx5sa3ftaj6gjcmtm7ynkl0e6crtt4ns8cnrmx%27%22&prove=false&page=1&per_page=100

        let expected = ParsedEvent::new(
            "neutron12p8wntzra3vpfcqv05scdx5sa3ftaj6gjcmtm7ynkl0e6crtt4ns8cnrmx".into(),
            InterchainGasPayment {
                message_id: H256::from_str(
                    "5dcf6120f8adf4f267eb1a122a85c42eae257fbc872671e93929fbf63daed19b",
                )
                .unwrap(),
                payment: U256::from(2),
                gas_amount: U256::from(25000),
                destination: 169,
            },
        );

        let assert_parsed_event = |attrs: &Vec<EventAttribute>| {
            let parsed_event =
                CosmosInterchainGasPaymasterIndexer::interchain_gas_payment_parser(attrs).unwrap();

            assert_eq!(parsed_event, expected);
        };

        // Non-base64 version
        let non_base64_attrs = event_attributes_from_str(
            r#"[{"key":"_contract_address","value":"neutron12p8wntzra3vpfcqv05scdx5sa3ftaj6gjcmtm7ynkl0e6crtt4ns8cnrmx", "index": true},{"key":"dest_domain","value":"169", "index": true},{"key":"gas_amount","value":"25000", "index": true},{"key":"gas_refunded","value":"0", "index": true},{"key":"gas_required","value":"2", "index": true},{"key":"message_id","value":"5dcf6120f8adf4f267eb1a122a85c42eae257fbc872671e93929fbf63daed19b", "index": true},{"key":"payment","value":"2", "index": true},{"key":"sender","value":"neutron1vdazwhwkh9wy6ue66pjpuvrxcrywv2ww956dq6ls2gh0n7t9f5rs2hydt2", "index": true}]"#,
        );
        assert_parsed_event(&non_base64_attrs);

        // Base64 version
        let base64_attrs = event_attributes_from_str(
            r#"[{"key":"X2NvbnRyYWN0X2FkZHJlc3M=","value":"bmV1dHJvbjEycDh3bnR6cmEzdnBmY3F2MDVzY2R4NXNhM2Z0YWo2Z2pjbXRtN3lua2wwZTZjcnR0NG5zOGNucm14","index":true},{"key":"ZGVzdF9kb21haW4=","value":"MTY5","index":true},{"key":"Z2FzX2Ftb3VudA==","value":"MjUwMDA=","index":true},{"key":"Z2FzX3JlZnVuZGVk","value":"MA==","index":true},{"key":"Z2FzX3JlcXVpcmVk","value":"Mg==","index":true},{"key":"bWVzc2FnZV9pZA==","value":"NWRjZjYxMjBmOGFkZjRmMjY3ZWIxYTEyMmE4NWM0MmVhZTI1N2ZiYzg3MjY3MWU5MzkyOWZiZjYzZGFlZDE5Yg==","index":true},{"key":"cGF5bWVudA==","value":"Mg==","index":true},{"key":"c2VuZGVy","value":"bmV1dHJvbjF2ZGF6d2h3a2g5d3k2dWU2NnBqcHV2cnhjcnl3djJ3dzk1NmRxNmxzMmdoMG43dDlmNXJzMmh5ZHQy","index":true}]"#,
        );

        assert_parsed_event(&base64_attrs);
    }
}
