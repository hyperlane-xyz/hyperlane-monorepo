use cosmrs::Any;
use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::v1::MsgProcessMessage;
use hyperlane_cosmos_rs::prost::{Message, Name};
use tonic::async_trait;

use super::consts::*;

use hyperlane_core::{
    ChainResult, ContractLocator, FixedPointNumber, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox, RawHyperlaneMessage,
    ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256, H512
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
    // TODO: not sure where used
    // it should return the number of dispatched messages so far
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        return Ok(0);
    }

    // check if a message already delivered TO kaspa
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        return Ok(false);
    }

    // there is no ism so return hardcode
    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(KASPA_ISM_ADDRESS)
    }

    /// Get the recipient ism address
    // (Supposed to use app router to the get ISM on Kaspa which will handle a specific token contract)
    async fn recipient_ism(&self, _recipient: H256) -> ChainResult<H256> {
        Ok(KASPA_ISM_ADDRESS)
    }

    // Actually sends up a MsgProcessMessage to the kaspa chain
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8], // contains sigs etc
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        Ok(TxOutcome {
            transaction_id: H512::zero(),
            executed: false,
            gas_used: U256::zero(),
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

    // used in payload derivation: https://github.com/dymensionxyz/hyperlane-monorepo/blob/7d0ae7590decd9ea09f6c88f8eeeb49df0295e19/rust/main/agents/relayer/src/msg/pending_message.rs#L551
    // although not sure what payload is for, seems like for 'lander'
    async fn process_calldata(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        todo!() // we dont need this for now (original HL comment)
    }

    // again, seems for lander mode only
    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}
