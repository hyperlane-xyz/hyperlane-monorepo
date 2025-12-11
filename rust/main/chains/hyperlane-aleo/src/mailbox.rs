use std::ffi::CStr;
use std::str::FromStr;

use async_trait::async_trait;
use snarkvm::prelude::{Address, FromBytes, Plaintext, ProgramID};

use aleo_serialize::AleoSerialize;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Encode, FixedPointNumber,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Mailbox, ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::provider::{AleoClient, FallbackHttpClient};
use crate::types::AleoGetMappingValue;
use crate::utils::{hash_to_aleo_hash, pad_to_length, to_h256};
use crate::{
    aleo_args, AleoMailboxStruct, AleoMessage, AleoProvider, AppMetadata, ConnectionConf,
    CurrentNetwork, Delivery, DeliveryKey, HyperlaneAleoError,
};

/// Aleo Ism
#[derive(Debug, Clone)]
pub struct AleoMailbox<C: AleoClient = FallbackHttpClient> {
    provider: AleoProvider<C>,
    address: H256,
    program: String,
    domain: HyperlaneDomain,
}

impl<C: AleoClient> AleoMailbox<C> {
    /// Returns a new Mailbox
    pub fn new(
        provider: AleoProvider<C>,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> Self {
        Self {
            provider,
            address: locator.address,
            program: conf.mailbox_program.clone(),
            domain: locator.domain.clone(),
        }
    }

    /// Get the ProgramID for a recipient address
    /// `recipient` - H256 address of the recipient
    ///
    /// Returns ProgramID<CurrentNetwork>
    ///
    /// In aleo there is no direct way to map from an H256 address to a ProgramID.
    /// Instead we look up the address in the `registered_applications` mapping of the mailbox program.
    /// This mapping stores the ProgramID for each registered recipient address.
    async fn get_recipient(&self, recipient: H256) -> ChainResult<ProgramID<CurrentNetwork>> {
        let aleo_address = Address::<CurrentNetwork>::from_bytes_le(recipient.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        let program_id: [u8; 128] = self
            .provider
            .get_mapping_value(&self.program, "registered_applications", &aleo_address)
            .await?
            .ok_or(HyperlaneAleoError::Other(format!(
                "Expected recipient to be registered, but was not: {aleo_address}",
            )))?;

        let program_id =
            CStr::from_bytes_until_nul(&program_id).map_err(HyperlaneAleoError::from)?;
        let program_id = program_id.to_str().map_err(HyperlaneAleoError::from)?;
        Ok(ProgramID::from_str(program_id).map_err(HyperlaneAleoError::from)?)
    }

    /// Get the arguments for processing a message
    /// `message` - HyperlaneMessage to process
    /// `metadata` - Metadata bytes needed to process the message
    /// Returns Vec<String> of arguments
    ///
    /// The metadata is padded or truncated to 512 bytes as required by the Aleo contracts.
    /// The message ID is converted to little endian u128 as required by the Aleo contracts.
    /// The ISM is looked up from the recipient's app metadata.
    /// The app metadata is also looked up from the recipient address.
    async fn get_process_args(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Vec<String>> {
        let message_length = message.to_vec().len() as u32;
        let aleo_message: AleoMessage = message.clone().into();

        // Pad with 1u8 as Aleo will error on zero bytes for the ECDSA recovery
        let metadata = pad_to_length::<512>(metadata.to_vec(), 1u8);

        let ism = self.recipient_ism(message.recipient).await?;
        let ism = Address::<CurrentNetwork>::from_bytes_le(ism.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        let id = hash_to_aleo_hash(&message.id())?;

        let recipient = self.get_recipient(message.recipient).await?.to_string();
        let app_metadata: Plaintext<CurrentNetwork> = self
            .provider
            .get_mapping_value(&recipient, "app_metadata", &true)
            .await?
            .ok_or(HyperlaneAleoError::AppUninitialized)?;

        aleo_args!(
            ism,
            app_metadata,
            aleo_message,
            message_length,
            id,
            metadata
        )
    }
}

#[async_trait]
impl<C: AleoClient> HyperlaneChain for AleoMailbox<C> {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl<C: AleoClient> HyperlaneContract for AleoMailbox<C> {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl<C: AleoClient> Mailbox for AleoMailbox<C> {
    /// Gets the current leaf count of the merkle tree
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let mailbox: AleoMailboxStruct = self
            .provider
            .get_mapping_value(&self.program, "mailbox", &true)
            .await?
            .ok_or(HyperlaneAleoError::MailboxUninitialized)?;
        Ok(mailbox.nonce)
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let key = DeliveryKey {
            id: hash_to_aleo_hash(&id)?,
        };

        let delivered: Option<Delivery> = self
            .provider
            .get_mapping_value(&self.program, "deliveries", &key)
            .await?;

        Ok(delivered.is_some())
    }

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256> {
        let mailbox: AleoMailboxStruct = self
            .provider
            .get_mapping_value(&self.program, "mailbox", &true)
            .await?
            .ok_or(HyperlaneAleoError::MailboxUninitialized)?;
        to_h256(mailbox.default_ism)
    }

    /// Returns the ISM for the given recipient address
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient = self.get_recipient(recipient).await?;
        // Each app stores its ISM in the `app_metadata` mapping
        let metadata: Option<AppMetadata> = self
            .provider
            .get_mapping_value(&recipient.to_string(), "app_metadata", &true)
            .await?;
        if let Some(metadata) = metadata {
            let address = to_h256(metadata.ism)?;
            // Only return if the address is non-zero
            if !address.is_zero() {
                return Ok(address);
            }
        }
        self.default_ism().await
    }

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let recipient = self.get_recipient(message.recipient).await?.to_string();
        let args = self.get_process_args(message, metadata).await?;

        self.provider
            .submit_tx_and_wait(&recipient, "process", args)
            .await
    }

    /// Estimate transaction costs to process a message.
    /// Arguments:
    /// - `message`: The message to be processed
    /// - `metadata`: The metadata needed to process the message
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let recipient = self.get_recipient(message.recipient).await?.to_string();
        let cost = self
            .provider
            .estimate_tx(
                &recipient,
                "process",
                self.get_process_args(message, metadata).await?,
            )
            .await?;
        Ok(TxCostEstimate {
            gas_limit: cost.total_fee.into(),
            gas_price: FixedPointNumber::from_str("1")?,
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
        let recipient = self.get_recipient(message.recipient).await?.to_string();
        let inputs = self.get_process_args(message, metadata).await?;

        let tx_data = crate::AleoTxData {
            program_id: recipient,
            function_name: "process".to_string(),
            inputs,
        };

        let json_val = serde_json::to_vec(&tx_data).map_err(ChainCommunicationError::from)?;
        Ok(json_val)
    }

    /// Get the calldata for a call which allows to check if a particular messages was delivered
    fn delivered_calldata(&self, message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        let id = hash_to_aleo_hash(&message_id)?;
        let key: Plaintext<CurrentNetwork> = DeliveryKey { id }
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;

        let get_mapping_value = AleoGetMappingValue {
            program_id: self.program.clone(),
            mapping_name: "deliveries".to_string(),
            mapping_key: key.to_string(),
        };

        let json_val =
            serde_json::to_vec(&get_mapping_value).map_err(ChainCommunicationError::from)?;
        Ok(Some(json_val))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{provider::mock::MockHttpClient, AleoMailbox, AleoProvider, ConnectionConf};
    use std::{path::PathBuf, str::FromStr};
    const DOMAIN: HyperlaneDomain =
        HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Abstract);

    fn connection_conf() -> ConnectionConf {
        ConnectionConf {
            rpcs: vec![url::Url::from_str("http://localhost:3030").unwrap()],
            mailbox_program: "test_mailbox.aleo".to_string(),
            hook_manager_program: "test_hook_manager.aleo".to_string(),
            ism_manager_program: "test_ism_manager.aleo".to_string(),
            validator_announce_program: "test_validator_announce.aleo".to_string(),
            chain_id: 1u16,
            priority_fee_multiplier: 0f64,
            proving_service: vec![],
        }
    }

    fn get_mock_mailbox() -> AleoMailbox<MockHttpClient> {
        let base_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/mailbox/mock_responses");
        let client: MockHttpClient = MockHttpClient::new(base_path);

        let provider = AleoProvider::with_client(client, DOMAIN, 0u16, None);
        let locator = ContractLocator::new(&DOMAIN, H256::zero());
        AleoMailbox::new(provider, &locator, &connection_conf())
    }

    #[tokio::test]
    async fn test_get_recipient() {
        let mailbox = get_mock_mailbox();
        mailbox.provider.register_value("program/test_mailbox.aleo/mapping/registered_applications/aleo18n8sg8cz6qc76vzflr8la98u0r4w8r96c9wdxee4wvetsvuz0vxs0r2hk8", "[\n  116u8,\n  101u8,\n  115u8,\n  116u8,\n  95u8,\n  104u8,\n  121u8,\n  112u8,\n  95u8,\n  110u8,\n  97u8,\n  116u8,\n  105u8,\n  118u8,\n  101u8,\n  46u8,\n  97u8,\n  108u8,\n  101u8,\n  111u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8\n]");
        let recipient_address =
            H256::from_str("0x3ccf041f02d031ed3049f8cffe94fc78eae38cbac15cd367357332b833827b0d")
                .unwrap();
        let result = mailbox.get_recipient(recipient_address).await;
        assert!(result.is_ok(), "Get recipient should succeed");
        let result = result.unwrap();
        assert_eq!(result.to_string(), "test_hyp_native.aleo");
    }

    #[tokio::test]
    async fn test_get_unknown_recipient() {
        let mailbox = get_mock_mailbox();
        mailbox.provider.register_value("program/test_mailbox.aleo/mapping/registered_applications/aleo18n8sg8cz6qc76vzflr8la98u0r4w8r96c9wdxee4wvetsvuz0vqsylpe9n", "[\n  116u8,\n  101u8,\n  115u8,\n  116u8,\n  95u8,\n  104u8,\n  121u8,\n  112u8,\n  95u8,\n  110u8,\n  97u8,\n  116u8,\n  105u8,\n  118u8,\n  101u8,\n  46u8,\n  97u8,\n  108u8,\n  101u8,\n  111u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8\n]");
        let recipient_address =
            H256::from_str("0x3ccf041f02d031ed3049f8cffe94fc78eae38cbac15cd367357332b833827b0d")
                .unwrap();
        let result = mailbox.get_recipient(recipient_address).await;
        assert!(result.is_err(), "Get unknown recipient should fail");
    }
}
