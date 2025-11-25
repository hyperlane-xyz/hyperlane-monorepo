use std::ffi::CStr;
use std::str::FromStr;

use async_trait::async_trait;
use snarkvm::prelude::{Address, FromBytes, Plaintext, ProgramID};

use hyperlane_core::{
    ChainResult, ContractLocator, Encode, FixedPointNumber, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox, ReorgPeriod, TxCostEstimate,
    TxOutcome, H256, U256,
};

use crate::utils::{hash_to_u128, to_h256};
use crate::{
    aleo_args, AleoMailboxStruct, AleoMessage, AleoProvider, AppMetadata, ConnectionConf,
    CurrentNetwork, Delivery, DeliveryKey, HyperlaneAleoError,
};

/// Aleo Ism
#[derive(Debug, Clone)]
pub struct AleoMailbox {
    provider: AleoProvider,
    address: H256,
    program: String,
    domain: HyperlaneDomain,
}

impl AleoMailbox {
    /// Returns a new Mailbox
    pub fn new(provider: AleoProvider, locator: &ContractLocator, conf: &ConnectionConf) -> Self {
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
            .await
            .map_err(|_| {
                HyperlaneAleoError::Other(format!(
                    "Expected recipient to be registered, but was not: {aleo_address}",
                ))
            })?;
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

        // Pad or truncate metadata to 512 bytes
        let copy_len = metadata.len().min(512);
        // Initialize with 1s as Aleo will error on zero bytes for the ECDSA recovery
        let mut buf = [1u8; 512];
        buf[..copy_len].copy_from_slice(&metadata[..copy_len]);
        let metadata = buf;

        let ism = self.recipient_ism(message.recipient).await?;
        let ism = Address::<CurrentNetwork>::from_bytes_le(ism.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        let id = hash_to_u128(&message.id())?;

        let recipient = self.get_recipient(message.recipient).await?.to_string();
        let app_metadata: Plaintext<CurrentNetwork> = self
            .provider
            .get_mapping_value(&recipient, "app_metadata", &true)
            .await?;

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
impl HyperlaneChain for AleoMailbox {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for AleoMailbox {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Mailbox for AleoMailbox {
    /// Gets the current leaf count of the merkle tree
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let mailbox: AleoMailboxStruct = self
            .provider
            .get_mapping_value(&self.program, "mailbox", &true)
            .await?;
        Ok(mailbox.nonce)
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let key = DeliveryKey {
            id: hash_to_u128(&id)?,
        };

        let delivered: ChainResult<Delivery> = self
            .provider
            .get_mapping_value(&self.program, "deliveries", &key)
            .await;

        Ok(delivered.is_ok())
    }

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256> {
        let mailbox: AleoMailboxStruct = self
            .provider
            .get_mapping_value(&self.program, "mailbox", &true)
            .await?;
        to_h256(mailbox.default_ism)
    }

    /// Returns the ISM for the given recipient address
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient = self.get_recipient(recipient).await?;
        // Each app stores its ISM in the `app_metadata` mapping
        let metadata: ChainResult<AppMetadata> = self
            .provider
            .get_mapping_value(&recipient.to_string(), "app_metadata", &true)
            .await;
        match metadata {
            Ok(metadata) => to_h256(metadata.ism),
            Err(_) => self.default_ism().await,
        }
    }

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let recipient = self.get_recipient(message.recipient).await?.to_string();
        self.provider
            .submit_tx(
                &recipient,
                "process",
                self.get_process_args(message, metadata).await?,
            )
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
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        // Not implemented, only needed for lander
        unimplemented!()
    }

    /// Get the calldata for a call which allows to check if a particular messages was delivered
    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        // Not implemented, only needed for lander
        unimplemented!()
    }
}
