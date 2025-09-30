use std::str::FromStr;

use async_trait::async_trait;
use core_api_client::models::{FeeSummary, TransactionStatus};
use radix_common::manifest_args;
use radix_common::prelude::ManifestArgs;
use regex::Regex;
use scrypto::{
    address::AddressBech32Decoder, network::NetworkDefinition, prelude::manifest_encode,
    types::ComponentAddress,
};

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Encode, FixedPointNumber,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Mailbox, ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::{
    address_from_h256, address_to_h256, encode_component_address, Bytes32, ConnectionConf,
    HyperlaneRadixError, RadixProvider, RadixTxCalldata,
};

// the number of simulate calls we do to get the necessary addresses
const NODE_DEPTH: usize = 5;

/// Radix mailbox
#[derive(Debug)]
pub struct RadixMailbox {
    provider: RadixProvider,
    encoded_address: String,
    address: ComponentAddress,
    address_256: H256,
    network: NetworkDefinition,
    component_regex: Regex,
}

impl RadixMailbox {
    /// New mailbox instance
    pub fn new(
        provider: RadixProvider,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let encoded_address = encode_component_address(&conf.network, locator.address)?;
        let address = address_from_h256(locator.address);
        let component_regex =
            regex::Regex::new(&format!(r"\w+_{}([a-zA-Z0-9]+)", conf.network.hrp_suffix))
                .map_err(ChainCommunicationError::from_other)?;

        Ok(Self {
            address,
            component_regex,
            network: conf.network.clone(),
            encoded_address,
            provider,
            address_256: locator.address,
        })
    }

    async fn visible_components(
        &self,
        message: &[u8],
        metadata: &[u8],
    ) -> ChainResult<(Vec<ComponentAddress>, FeeSummary)> {
        let decoder = AddressBech32Decoder::new(&self.network);
        let mut visible_components = Vec::new();
        let mut fee_summary = FeeSummary::default();

        // in radix all addresses/node have to visible for a transaction to be valid
        // we simulate the tx first to get the necessary addresses
        for _ in 0..NODE_DEPTH {
            // we need to simulate the tx multiple times to get all the necessary addresses
            let result = self
                .provider
                .simulate_tx(|builder| {
                    builder.call_method(
                        self.address,
                        "process",
                        manifest_args!(&metadata, &message, visible_components.clone()),
                    )
                })
                .await?;
            fee_summary = result.fee_summary;
            if result.status == TransactionStatus::Succeeded {
                break;
            }

            // luckily there is a fixed error message if a node is not visible
            // we match against that error message and extract the invisible component
            let error_message = result.error_message.unwrap_or_default();
            if let Some(matched) = self.component_regex.find(&error_message) {
                if let Some(component_address) =
                    ComponentAddress::try_from_bech32(&decoder, matched.as_str())
                {
                    visible_components.push(component_address);
                }
            } else {
                // early return if the error message is caused by something else than an invisible node
                return Ok((visible_components, fee_summary));
            }
        }

        Ok((visible_components, fee_summary))
    }

    async fn build_process_calldata(
        encoded_address: &str,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        let message = message.to_vec();
        let metadata = metadata.to_vec();

        let args = manifest_args!(&metadata, &message);

        let encoded_arguments = manifest_encode(&args).map_err(HyperlaneRadixError::from)?;

        let data = RadixTxCalldata {
            component_address: encoded_address.to_string(),
            method_name: "process".into(),
            encoded_arguments,
        };
        let json_str =
            serde_json::to_string(&data).map_err(ChainCommunicationError::JsonParseError)?;
        Ok(json_str.as_bytes().to_vec())
    }

    fn build_delivered_calldata(
        encoded_address: &str,
        message_id: H256,
    ) -> ChainResult<Option<Vec<u8>>> {
        let id: Bytes32 = message_id.into();
        let encoded_arguments = manifest_encode(&id).map_err(HyperlaneRadixError::from)?;

        let calldata = RadixTxCalldata {
            component_address: encoded_address.to_string(),
            method_name: "delivered".into(),
            encoded_arguments,
        };
        let json_val =
            serde_json::to_vec(&calldata).map_err(ChainCommunicationError::JsonParseError)?;
        Ok(Some(json_val))
    }
}

impl HyperlaneContract for RadixMailbox {
    fn address(&self) -> H256 {
        self.address_256
    }
}

impl HyperlaneChain for RadixMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl Mailbox for RadixMailbox {
    /// Gets the current number of dispatched messages
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        Ok(self
            .provider
            .call_method::<u32>(
                &self.encoded_address,
                "count",
                Some(reorg_period),
                Vec::new(),
            )
            .await?
            .0)
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let id: Bytes32 = id.into();
        self.provider
            .call_method_with_arg(&self.encoded_address, "delivered", &id)
            .await
    }

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256> {
        let (default_ism, _) = self
            .provider
            .call_method::<Option<ComponentAddress>>(
                &self.encoded_address,
                "default_ism",
                None,
                Vec::new(),
            )
            .await?;
        match default_ism {
            Some(ism) => Ok(address_to_h256(ism)),
            None => Err(HyperlaneRadixError::Other("no default ism present".to_owned()).into()),
        }
    }

    /// Get the recipient ism address
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient = address_from_h256(recipient);

        let recipient_ism: Option<ComponentAddress> = self
            .provider
            .call_method_with_arg(&self.encoded_address, "recipient_ism", &recipient)
            .await?;
        match recipient_ism {
            Some(ism) => Ok(address_to_h256(ism)),
            None => Err(HyperlaneRadixError::Other("no recipient ism present".to_owned()).into()),
        }
    }

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let message = message.to_vec();
        let metadata = metadata.to_vec();
        let (visible_components, fee_summary) =
            self.visible_components(&message, &metadata).await?;
        self.provider
            .send_tx(
                |builder| {
                    builder.call_method(
                        self.address,
                        "process",
                        manifest_args!(&metadata, &message, &visible_components),
                    )
                },
                Some(fee_summary),
            )
            .await
    }

    /// Estimate transaction costs to process a message.
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let message = message.to_vec();
        let metadata = metadata.to_vec();
        let (_, summary) = self.visible_components(&message, &metadata).await?;
        let total_units =
            summary.execution_cost_units_consumed + summary.finalization_cost_units_consumed;

        let paid = RadixProvider::total_fee(summary)?;
        let paid = if total_units == 0 {
            paid
        } else {
            paid / total_units
        };

        // TODO:
        Ok(TxCostEstimate {
            gas_limit: total_units.into(),
            gas_price: FixedPointNumber::from_str(&paid.to_string())?,
            l2_gas_limit: None,
        })
    }

    /// Get the calldata for a transaction to process a message with a proof
    /// against the provided signed checkpoint
    async fn process_calldata(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        Self::build_process_calldata(&self.encoded_address, message, metadata).await
    }

    /// Data required to make a TransactionCallPreviewRequest to
    /// check if a message was delivered or not on-chain.
    fn delivered_calldata(&self, message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        Self::build_delivered_calldata(&self.encoded_address, message_id)
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::{Encode, HyperlaneMessage, H256};
    use radix_common::manifest_args;
    use scrypto::prelude::{manifest_encode, ManifestArgs};

    use crate::{Bytes32, RadixMailbox, RadixTxCalldata};

    const MAILBOX_ADDRESS: &str =
        "component_rdx1cpcq2wcs8zmpjanjf5ek76y4wttdxswnyfcuhynz4zmhjfjxqfsg9z";

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_process_calldata() {
        let message = HyperlaneMessage::default();
        let metadata = vec![20, 30, 40, 50];
        let calldata = RadixMailbox::build_process_calldata(MAILBOX_ADDRESS, &message, &metadata)
            .await
            .expect("Failed to build process calldata");

        let args: ManifestArgs = manifest_args!(metadata.clone(), message.to_vec());
        let encoded_arguments = manifest_encode(&args).expect("Failed to encode args");
        let expected = RadixTxCalldata {
            component_address: MAILBOX_ADDRESS.to_string(),
            method_name: "process".into(),
            encoded_arguments,
        };

        let actual: RadixTxCalldata =
            serde_json::from_slice(&calldata).expect("Failed to parse json");
        assert_eq!(actual, expected);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_delivered_calldata() {
        let message_id = H256::random();
        let calldata = RadixMailbox::build_delivered_calldata(MAILBOX_ADDRESS, message_id)
            .expect("Failed to build delivered calldata")
            .expect("Delivered calldata is empty");

        let id: Bytes32 = message_id.into();
        let encoded_arguments = manifest_encode(&id).expect("Failed to encode args");
        let expected = RadixTxCalldata {
            component_address: MAILBOX_ADDRESS.to_string(),
            method_name: "delivered".into(),
            encoded_arguments,
        };

        let actual: RadixTxCalldata =
            serde_json::from_slice(&calldata).expect("Failed to parse json");
        assert_eq!(actual, expected);
    }
}
