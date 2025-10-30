use std::{str::FromStr, sync::OnceLock};

use aleo_serialize::AleoSerialize;
use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, FixedPointNumber, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox, ReorgPeriod, TxCostEstimate,
    TxOutcome, H256, U256,
};
use snarkvm::prelude::Itertools;
use snarkvm::prelude::{Address, Boolean, FromBytes, Literal, Plaintext, ProgramID, U128, U32, U8};

use crate::{
    hash_to_u128, to_h256, AleoMailboxStruct, AleoMessage, AleoProvider, AleoSigner,
    ConnectionConf, CurrentNetwork, Delivery, HttpClient, HyperlaneAleoError,
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
    /// TODO: parse settings
    pub fn new(provider: AleoProvider, locator: &ContractLocator, conf: &ConnectionConf) -> Self {
        return Self {
            provider,
            address: locator.address,
            program: conf.mailbox_program.clone(),
            domain: locator.domain.clone(),
        };
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
            .get_mapping_value(&self.program, "mailbox", "true")
            .await?;
        Ok(*mailbox.nonce)
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        // TODO: better tooling
        let first = U128::<CurrentNetwork>::from_bytes_le(&id.0[0..16])
            .map_err(HyperlaneAleoError::from)?;
        let second =
            U128::<CurrentNetwork>::from_bytes_le(&id.0[16..]).map_err(HyperlaneAleoError::from)?;

        let id = [first, second]
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;

        let delivered: ChainResult<Delivery> = self
            .provider
            .get_mapping_value(&self.program, "deliveries", &format!("{{id: {}}}", id))
            .await;

        Ok(delivered.is_ok())
    }

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256> {
        let mailbox: AleoMailboxStruct = self
            .provider
            .get_mapping_value(&self.program, "mailbox", "true")
            .await?;
        to_h256(mailbox.default_ism)
    }

    /// Get the latest checkpoint.
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        // TODO:
        self.default_ism().await
    }

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let mut body_words: [U128<CurrentNetwork>; 8] = [U128::new(0); 8];
        for i in 0..8 {
            let start = i * 16;
            if start < message.body.len() {
                let end = usize::min(start + 16, message.body.len());
                let mut buf = [0u8; 16];
                buf[..end - start].copy_from_slice(&message.body[start..end]);
                body_words[i] = U128::from_bytes_le(&buf).map_err(HyperlaneAleoError::from)?;
            }
        }

        let aleo_message: AleoMessage = AleoMessage {
            version: U8::new(message.version),
            nonce: U32::new(message.nonce),
            origin_domain: U32::new(message.origin),
            sender: message.sender.as_fixed_bytes().map(|x| U8::new(x)),
            destination_domain: U32::new(message.destination),
            recipient: message.recipient.as_fixed_bytes().map(|x| U8::new(x)),
            body: body_words,
        };

        let aleo_metadata: [U8<CurrentNetwork>; 512] = [U8::new(0); 512];
        // let target = metadata.iter().map(|x| U8::new(*x)).collect_vec();
        // aleo_metadata.copy_from_slice(&target);

        let metadata = aleo_metadata
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;

        let message_length = U32::<CurrentNetwork>::new(message.body.len() as u32 + 77)
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;
        let id = hash_to_u128(&message.id())?
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;

        let message = aleo_message
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;
        let program_id =
            ProgramID::from_str("hyp_native_template.aleo").map_err(HyperlaneAleoError::from)?;

        let mailbox: AleoMailboxStruct = self
            .provider
            .get_mapping_value(&self.program, "mailbox", "true")
            .await?;
        let ism = mailbox
            .default_ism
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;

        self.provider
            .submit_tx(
                &program_id,
                vec![ism, message, message_length, id, metadata],
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
        message: &HyperlaneMessage,
        metadata: &[u8],
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
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        todo!()
    }

    /// Get the calldata for a call which allows to check if a particular messages was delivered
    fn delivered_calldata(&self, message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}
