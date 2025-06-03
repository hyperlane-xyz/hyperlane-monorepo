use cosmrs::Any;
use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::v1::MsgProcessMessage;
use hyperlane_cosmos_rs::prost::{Message, Name};
use tonic::async_trait;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, FixedPointNumber, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox,
    RawHyperlaneMessage, ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::CosmosNativeProvider;

/// Cosmos Native Mailbox
#[derive(Debug, Clone)]
pub struct CosmosNativeMailbox {
    provider: CosmosNativeProvider,
    domain: HyperlaneDomain,
    address: H256,
}

impl CosmosNativeMailbox {
    /// new cosmos native mailbox instance
    pub fn new(
        provider: CosmosNativeProvider,
        locator: ContractLocator,
    ) -> ChainResult<CosmosNativeMailbox> {
        Ok(CosmosNativeMailbox {
            provider,
            address: locator.address,
            domain: locator.domain.clone(),
        })
    }

    fn encode_hyperlane_message(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Any> {
        let mailbox_id: String = self.address.encode_hex();
        let message = hex::encode(RawHyperlaneMessage::from(message));
        let metadata = hex::encode(metadata);
        let signer = self.provider.rpc().get_signer()?.address_string.clone();
        let process = MsgProcessMessage {
            mailbox_id: "0x".to_string() + &mailbox_id,
            metadata,
            message,
            relayer: signer,
        };
        Ok(Any {
            type_url: MsgProcessMessage::type_url(),
            value: process.encode_to_vec(),
        })
    }
}

impl HyperlaneChain for CosmosNativeMailbox {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for CosmosNativeMailbox {
    /// Return the address of this contract
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
        let height = self.provider.reorg_to_height(reorg_period).await?;
        let mailbox = self
            .provider
            .grpc()
            .mailbox(self.address.encode_hex(), Some(height))
            .await?;
        Ok(mailbox.mailbox.map(|m| m.message_sent).unwrap_or(0))
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let delivered = self
            .provider
            .grpc()
            .delivered(self.address.encode_hex(), id.encode_hex())
            .await?;
        Ok(delivered.delivered)
    }

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256> {
        let mailbox = self
            .provider
            .grpc()
            .mailbox(self.address.encode_hex(), None)
            .await?;
        match mailbox.mailbox {
            Some(mailbox) => {
                let ism: H256 = mailbox.default_ism.parse()?;
                Ok(ism)
            }
            None => Err(ChainCommunicationError::from_other_str("no default ism")),
        }
    }

    /// Get the recipient ism address
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient = self
            .provider
            .grpc()
            .recipient_ism(recipient.encode_hex())
            .await?;
        let recipient: H256 = recipient.ism_id.parse()?;
        Ok(recipient)
    }

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let any_encoded = self.encode_hyperlane_message(message, metadata)?;
        let gas_limit: Option<u64> = tx_gas_limit.map(|gas| gas.as_u64());

        let response = self
            .provider
            .rpc()
            .send(vec![any_encoded], gas_limit)
            .await?;

        // we assume that the underlying cosmos chain does not have gas refunds
        // in that case the gas paid will always be:
        // gas_wanted * gas_price
        let gas_price =
            FixedPointNumber::from(response.tx_result.gas_wanted) * self.provider.rpc().gas_price();

        Ok(TxOutcome {
            transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
            executed: response.tx_result.code.is_ok() && response.check_tx.code.is_ok(),
            gas_used: response.tx_result.gas_used.into(),
            gas_price,
        })
    }

    /// Estimate transaction costs to process a message.
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let any_encoded = self.encode_hyperlane_message(message, metadata)?;
        let gas_limit = self.provider.rpc().estimate_gas(vec![any_encoded]).await?;

        Ok(TxCostEstimate {
            gas_limit: gas_limit.into(),
            gas_price: self.provider.rpc().gas_price(),
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
        todo!() // we dont need this for now
    }

    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}
