use cosmrs::{proto::cosmos::base::abci::v1beta1::TxResponse, Any, Tx};
use hex::ToHex;
use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox,
    RawHyperlaneMessage, ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
};
use prost::Message;
use tonic::async_trait;

use crate::{
    ConnectionConf, CosmosNativeProvider, HyperlaneCosmosError, MsgProcessMessage, Signer,
};

/// Cosmos Native Mailbox
#[derive(Debug, Clone)]
pub struct CosmosNativeMailbox {
    provider: CosmosNativeProvider,
    domain: HyperlaneDomain,
    address: H256,
    signer: Option<Signer>,
}

impl CosmosNativeMailbox {
    /// new cosmos native mailbox instance
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<CosmosNativeMailbox> {
        Ok(CosmosNativeMailbox {
            provider: CosmosNativeProvider::new(
                locator.domain.clone(),
                conf.clone(),
                locator.clone(),
                signer.clone(),
            )?,
            signer,
            address: locator.address.clone(),
            domain: locator.domain.clone(),
        })
    }

    fn encode_hyperlane_message(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Any {
        let mailbox_id: String = self.address.encode_hex();
        let message = hex::encode(RawHyperlaneMessage::from(message));
        let metadata = hex::encode(metadata);
        let signer = self
            .signer
            .as_ref()
            .map_or("".to_string(), |signer| signer.address.clone());
        let process = MsgProcessMessage {
            mailbox_id: "0x".to_string() + &mailbox_id,
            metadata,
            message,
            relayer: signer,
        };
        Any {
            type_url: "/hyperlane.core.v1.MsgProcessMessage".to_string(),
            value: process.encode_to_vec(),
        }
    }
}

impl HyperlaneChain for CosmosNativeMailbox {
    #[doc = " Return the domain"]
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    #[doc = " A provider for the chain"]
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for CosmosNativeMailbox {
    #[doc = " Return the address of this contract."]
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Mailbox for CosmosNativeMailbox {
    /// Gets the current leaf count of the merkle tree
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        self.provider
            .rest()
            .leaf_count(self.address, reorg_period.clone())
            .await
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        self.provider.rest().delivered(id).await
    }

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256> {
        let mailbox = self
            .provider
            .rest()
            .mailbox(self.address, ReorgPeriod::None)
            .await?;
        let default_ism: H256 = mailbox.default_ism.parse()?;
        return Ok(default_ism);
    }

    /// Get the recipient ism address
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        self.provider.rest().recipient_ism(recipient).await
    }

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let any_encoded = self.encode_hyperlane_message(message, metadata);
        let gas_limit = match tx_gas_limit {
            Some(gas) => Some(gas.as_u64()),
            None => None,
        };

        let response = self
            .provider
            .rpc()
            .send(vec![any_encoded], gas_limit)
            .await?;

        let tx = TxResponse::decode(response.data).map_err(HyperlaneCosmosError::from)?;

        Ok(TxOutcome {
            transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
            executed: tx.code == 0,
            gas_used: tx.gas_used.into(),
            gas_price: U256::one().try_into()?,
        })
    }

    /// Estimate transaction costs to process a message.
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let hex_string = hex::encode(metadata);
        let any_encoded = self.encode_hyperlane_message(message, metadata);
        let gas_limit = self.provider.rpc().estimate_gas(vec![any_encoded]).await?;
        Ok(TxCostEstimate {
            gas_limit: gas_limit.into(),
            gas_price: self.provider.rpc().gas_price(),
            l2_gas_limit: None,
        })
    }

    /// Get the calldata for a transaction to process a message with a proof
    /// against the provided signed checkpoint
    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        todo!() // we dont need this for now
    }
}
