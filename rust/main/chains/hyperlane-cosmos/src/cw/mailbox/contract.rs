use std::str::FromStr;

use async_trait::async_trait;
use tracing::instrument;

use hyperlane_core::{
    utils::bytes_to_hex, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox, RawHyperlaneMessage,
    ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
};

use super::super::payloads;
use super::super::payloads::general;
use super::super::payloads::mailbox::{
    GeneralMailboxQuery, ProcessMessageRequest, ProcessMessageRequestInner,
};
use crate::{cw::CwQueryClient, utils, ConnectionConf, CosmosAddress, CosmosProvider};

#[derive(Clone, Debug)]
/// A reference to a Mailbox contract on some Cosmos chain
pub struct CwMailbox {
    config: ConnectionConf,
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider<CwQueryClient>,
}

impl CwMailbox {
    /// Create a reference to a mailbox at a specific Cosmos address on some
    /// chain
    pub fn new(
        provider: CosmosProvider<CwQueryClient>,
        conf: ConnectionConf,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
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

impl HyperlaneContract for CwMailbox {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CwMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl Mailbox for CwMailbox {
    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let block_height = self.provider.reorg_to_height(reorg_period).await?;
        self.nonce_at_block(block_height).await
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let id = hex::encode(id);
        let payload = payloads::mailbox::DeliveredRequest {
            message_delivered: payloads::mailbox::DeliveredRequestInner { id },
        };

        let delivered = self
            .provider
            .query()
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, None)
            .await
            .map(|v| serde_json::from_slice::<payloads::mailbox::DeliveredResponse>(&v))??;

        Ok(delivered.delivered)
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn default_ism(&self) -> ChainResult<H256> {
        let payload = payloads::mailbox::DefaultIsmRequest {
            default_ism: general::EmptyStruct {},
        };

        let data = self
            .provider
            .query()
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, None)
            .await?;
        let response: payloads::mailbox::DefaultIsmResponse = serde_json::from_slice(&data)?;

        // convert bech32 to H256
        let ism = CosmosAddress::from_str(&response.default_ism)?;
        Ok(ism.digest())
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let address = CosmosAddress::from_h256(
            recipient,
            &self.bech32_prefix(),
            self.contract_address_bytes(),
        )?
        .address();

        let payload = payloads::mailbox::RecipientIsmRequest {
            recipient_ism: payloads::mailbox::RecipientIsmRequestInner {
                recipient_addr: address,
            },
        };

        let data = self
            .provider
            .query()
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, None)
            .await?;
        let response: payloads::mailbox::RecipientIsmResponse = serde_json::from_slice(&data)?;

        // convert bech32 to H256
        let ism = CosmosAddress::from_str(&response.ism)?;
        Ok(ism.digest())
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
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

        let msg = self.provider.query().wasm_encode_msg(process_message)?;

        let response = self
            .provider
            .rpc()
            .send(vec![msg], tx_gas_limit.map(|gas| gas.as_u64()))
            .await?;

        Ok(utils::tx_response_to_outcome(
            response,
            self.provider.rpc().gas_price(),
        ))
    }

    #[instrument(err, ret, skip(self), fields(hyp_message=%message, metadata=%bytes_to_hex(metadata)))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
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
        let msg = self.provider.query().wasm_encode_msg(process_message)?;
        let gas_limit = self.provider.rpc().estimate_gas(vec![msg]).await?;

        let result = TxCostEstimate {
            gas_limit: gas_limit.into(),
            gas_price: self.provider.rpc().gas_price(),
            l2_gas_limit: None,
        };

        Ok(result)
    }

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        todo!() // not required
    }
}

impl CwMailbox {
    #[instrument(level = "debug", err, ret, skip(self))]
    pub(crate) async fn nonce_at_block(&self, block_height: Option<u64>) -> ChainResult<u32> {
        let payload = payloads::mailbox::NonceRequest {
            nonce: general::EmptyStruct {},
        };

        let data = self
            .provider
            .query()
            .wasm_query(GeneralMailboxQuery { mailbox: payload }, block_height)
            .await?;

        let response: payloads::mailbox::NonceResponse = serde_json::from_slice(&data)?;

        Ok(response.nonce)
    }
}
