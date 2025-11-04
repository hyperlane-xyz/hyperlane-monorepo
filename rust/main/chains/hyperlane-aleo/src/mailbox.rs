use std::ffi::CStr;
use std::str::FromStr;

use async_trait::async_trait;
use snarkvm::prelude::{Address, FromBytes, ProgramID};

use hyperlane_core::{
    ChainResult, ContractLocator, Encode, FixedPointNumber, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox, ReorgPeriod, TxCostEstimate,
    TxOutcome, H256, U256,
};

use crate::utils::{hash_to_u128, to_h256};
use crate::{
    aleo_args, AleoMailboxStruct, AleoMessage, AleoProvider, ConnectionConf, CurrentNetwork,
    Delivery, DeliveryKey, HyperlaneAleoError,
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
        return Self {
            provider,
            address: locator.address,
            program: conf.mailbox_program.clone(),
            domain: locator.domain.clone(),
        };
    }

    async fn get_recipient(&self, recipient: H256) -> ChainResult<ProgramID<CurrentNetwork>> {
        let aleo_address = Address::<CurrentNetwork>::from_bytes_le(recipient.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        let program_id: [u8; 128] = self
            .provider
            .get_mapping_value(&self.program, "registered_applications", &aleo_address)
            .await
            .map_err(|_| {
                HyperlaneAleoError::Other(format!(
                    "Expected recipient to be registered, but was not: {}",
                    aleo_address,
                ))
            })?;
        let program_id =
            CStr::from_bytes_until_nul(&program_id).map_err(HyperlaneAleoError::from)?;
        let program_id = program_id.to_str().map_err(HyperlaneAleoError::from)?;
        Ok(ProgramID::from_str(program_id).map_err(HyperlaneAleoError::from)?)
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

    /// Get the latest checkpoint.
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient = self.get_recipient(recipient).await?;
        let ism: ChainResult<Address<CurrentNetwork>> = self
            .provider
            .get_mapping_value(&recipient.to_string(), "ism", &true)
            .await;
        match ism {
            Ok(ism) => to_h256(ism),
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
        let message_length = message.to_vec().len() as u32;

        let mut body_words: [u128; 8] = [0u128; 8];
        for i in 0..8 {
            let start = i * 16;
            if start < message.body.len() {
                let end = usize::min(start + 16, message.body.len());
                let mut buf = [0u8; 16];
                buf[..end - start].copy_from_slice(&message.body[start..end]);
                body_words[i] = u128::from_bytes_le(&buf).map_err(HyperlaneAleoError::from)?;
            }
        }

        let aleo_message: AleoMessage = AleoMessage {
            version: message.version,
            nonce: message.nonce,
            origin_domain: message.origin,
            sender: message.sender.to_fixed_bytes(),
            destination_domain: message.destination,
            recipient: message.recipient.to_fixed_bytes(),
            body: body_words,
        };

        let copy_len = metadata.len().min(512);
        let mut buf = [0u8; 512];
        buf[..copy_len].copy_from_slice(&metadata[..copy_len]);
        let metadata = buf;

        let ism = self.recipient_ism(message.recipient).await?;
        let ism = Address::<CurrentNetwork>::from_bytes_le(ism.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        let id = hash_to_u128(&message.id())?;

        self.provider
            .submit_tx(
                &self.program,
                aleo_args!(ism, aleo_message, message_length, id, metadata)?,
                "process",
            )
            .await
    }

    /// Estimate transaction costs to process a message.
    /// Arguments:
    /// - `message`: The message to be processed
    /// - `metadata`: The metadata needed to process the message
    async fn process_estimate_costs(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        Ok(TxCostEstimate {
            gas_limit: U256::one(),
            gas_price: FixedPointNumber::zero(),
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
        todo!()
    }

    /// Get the calldata for a call which allows to check if a particular messages was delivered
    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}
