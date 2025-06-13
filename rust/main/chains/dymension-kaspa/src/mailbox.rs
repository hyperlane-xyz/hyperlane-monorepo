use cosmrs::Any;
use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::v1::MsgProcessMessage;
use hyperlane_cosmos_rs::prost::{Message, Name};
use tonic::async_trait;

use super::consts::*;

use hyperlane_core::{
    ChainResult, ContractLocator, FixedPointNumber, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox,
    RawHyperlaneMessage, ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::KaspaProvider;

// pretends to be a mailbox
#[derive(Debug, Clone)]
pub struct KaspaFakeMailbox {
    provider: KaspaProvider,
    domain: HyperlaneDomain,
    address: H256,
}

impl KaspaFakeMailbox {
    /// new kaspa native mailbox instance
    pub fn new(provider: KaspaProvider, locator: ContractLocator) -> ChainResult<KaspaFakeMailbox> {
        Ok(KaspaFakeMailbox {
            provider,
            address: locator.address, // TODO: will be zero?
            domain: locator.domain.clone(),
        })
    }

    // TODO: where used?
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

impl HyperlaneChain for KaspaFakeMailbox {
    /// Hardcoded // TODO: security implications?
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for KaspaFakeMailbox {
    /// Hardcoded // TODO: security implications?
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Mailbox for KaspaFakeMailbox {
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

    // there is no ism so return hardcode
    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(KASPA_ISM_ADDRESS)
    }

    /// Get the recipient ism address
    async fn recipient_ism(&self, _recipient: H256) -> ChainResult<H256> {
        Ok(KASPA_ISM_ADDRESS)
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

        Ok(TxOutcome {
            transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
            executed: response.tx_result.code.is_ok() && response.check_tx.code.is_ok(),
            gas_used: 0.into(),
            gas_price: FixedPointNumber::from(0),
        })
    }

    async fn process_estimate_costs(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        Ok(TxCostEstimate {
            gas_limit: 0.into(),
            gas_price: FixedPointNumber::from(0),
            l2_gas_limit: None,
        })
    }

    // TODO: what is this for?
    async fn process_calldata(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        todo!() // we dont need this for now (original HL comment)
    }

    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}
