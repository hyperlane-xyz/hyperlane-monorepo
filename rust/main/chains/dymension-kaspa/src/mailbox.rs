use cosmrs::Any;
use hex::ToHex;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{WithdrawalId, WithdrawalStatus};
use hyperlane_cosmos_rs::hyperlane::core::v1::MsgProcessMessage;
use hyperlane_cosmos_rs::prost::{Message, Name};
use tonic::async_trait;

use super::consts::*;

use hyperlane_core::{
    BatchItem, BatchResult, ChainCommunicationError, ChainResult, ContractLocator,
    FixedPointNumber, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, Mailbox, QueueOperation, RawHyperlaneMessage, ReorgPeriod, TxCostEstimate,
    TxOutcome, H256, H512, U256,
};

use crate::KaspaProvider;

// pretends to be a mailbox
#[derive(Debug, Clone)]
pub struct KaspaMailbox {
    provider: KaspaProvider,
    domain: HyperlaneDomain,
    address: H256,
}

impl KaspaMailbox {
    /// new kaspa native mailbox instance
    pub fn new(provider: KaspaProvider, locator: ContractLocator) -> ChainResult<KaspaMailbox> {
        Ok(KaspaMailbox {
            provider,
            address: locator.address, // TODO: will be zero?
            domain: locator.domain.clone(),
        })
    }

    pub fn with_provider(&self, provider: KaspaProvider) -> Self {
        Self {
            provider,
            domain: self.domain.clone(),
            address: self.address,
        }
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
        let signer = self.provider.rest().get_signer()?.address_string.clone();
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

impl HyperlaneChain for KaspaMailbox {
    /// Hardcoded // TODO: security implications?
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for KaspaMailbox {
    /// Hardcoded // TODO: security implications?
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Mailbox for KaspaMailbox {
    // TODO: not sure where used
    // it should return the number of dispatched messages so far
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        return Ok(0);
    }

    // check if a message already delivered TO kaspa
    // not a precise answer since actually depends on subsequent confirmation step
    // so may often return false negative
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let wid = WithdrawalId {
            message_id: id.to_string(),
        };
        let res = self
            .provider
            .hub_rpc()
            .withdrawal_status(vec![wid], None)
            .await?;
        match res
            .status
            .first()
            .map(|s| WithdrawalStatus::try_from(*s).ok())
        {
            Some(Some(WithdrawalStatus::Processed)) => Ok(true),
            _ => Ok(false),
        }
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

    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8], // contains sigs etc
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        /*
        There is a flow where the relayer will try to submit a batch and any failures will get retried via this method
        We should
         */
        unimplemented!("kas does not support single message processing")
    }

    /// True if the destination chain supports batching
    /// (i.e. if the mailbox contract will succeed on a `process_batch` call)
    fn supports_batching(&self) -> bool {
        true
    }

    // We hijack this https://github.com/dymensionxyz/hyperlane-monorepo/blob/4ecb864de578648e0c0ef39561f291cd7f4dfe7c/rust/main/agents/relayer/src/msg/op_submitter.rs#L1084
    async fn process_batch<'a>(&self, ops: Vec<&'a QueueOperation>) -> ChainResult<BatchResult> {
        let messages: Vec<HyperlaneMessage> = ops
            .iter()
            .map(|op| op.try_batch().map(|item| item.data)) // TODO: please work...
            .collect::<ChainResult<Vec<HyperlaneMessage>>>()?;

        let fxg_res = self.provider.construct_withdrawal(messages).await?;
        let fxg = fxg_res.ok_or(ChainCommunicationError::BatchingFailed)?;

        let res = self.provider.process_withdrawal(&fxg).await?;

        Ok(BatchResult {
            outcome: Some(TxOutcome {
                transaction_id: H512::zero(),
                executed: false,
                gas_used: U256::zero(),
                gas_price: FixedPointNumber::from(0),
            }),
            failed_indexes: vec![],
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
