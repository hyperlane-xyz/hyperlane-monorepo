use super::consts::*;
use crate::KaspaProvider;
use dym_kas_relayer::withdraw::minimum::is_small_value;
use hyperlane_core::{
    utils::bytes_to_hex, BatchResult, ChainResult, ContractLocator, Decode, FixedPointNumber,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Mailbox, QueueOperation, ReorgPeriod, TxCostEstimate, TxOutcome, H256, H512, U256,
};
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{WithdrawalId, WithdrawalStatus};
use hyperlane_warp_route::TokenMessage;
use tonic::async_trait;
use tracing::info;

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
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        return Ok(0);
    }

    // check if a message already delivered TO kaspa
    // not a precise answer since actually depends on subsequent confirmation step
    // so may often return false negative
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        info!("Kaspa mailbox, checking if message is delivered already (querying hub), id: {id:?}");
        let wid = WithdrawalId {
            message_id: bytes_to_hex(id.as_ref()),
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
        _message: &HyperlaneMessage,
        _metadata: &[u8], // contains sigs etc
        _tx_gas_limit: Option<U256>,
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
        info!(
            "Kaspa mailbox, processing/submitting kaspa batch of size: {}",
            ops.len()
        );

        if self.provider.has_pending_confirmation() {
            // All indexes are considered failed if there is a pending confirmation. they will be retried later.
            let failed_indexes: Vec<usize> = (0..ops.len()).collect();
            return Ok(BatchResult {
                failed_indexes,
                outcome: None,
            });
        }

        let messages: Vec<HyperlaneMessage> = ops
            .iter()
            .map(|op| op.try_batch().map(|item| item.data)) // TODO: please work...
            .collect::<ChainResult<Vec<HyperlaneMessage>>>()?;

        let processed_messages = self
            .provider
            .process_withdrawal_messages(messages.clone())
            .await?;
        info!("Kaspa mailbox, processed withdrawals TXs");

        // Note: this return value doesn't really correspond well to what we did, since we sent (possibly) multiple TXs to Kaspa
        // however, since the TXs must go in sequence, we can take the last one, knowing all the prior ones were accepted
        // failed indexes should say which hyperlane messages were accepted

        let failed = {
            let mut failed = vec![];
            for (i, msg) in messages.iter().enumerate() {
                if !processed_messages.contains(msg) {
                    failed.push(i);
                }
            }
            failed
        };

        Ok(BatchResult {
            outcome: Some(TxOutcome {
                transaction_id: H512::zero(),
                executed: false,
                gas_used: U256::zero(),
                gas_price: FixedPointNumber::from(0),
            }),
            failed_indexes: failed,
        })
    }

    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let token_msg = match TokenMessage::read_from(&mut message.body.as_slice()) {
            Ok(msg) => msg,
            Err(e) => {
                return Ok(TxCostEstimate {
                    gas_limit: 0.into(),
                    gas_price: FixedPointNumber::from(0),
                    l2_gas_limit: None,
                });
            }
        };

        if is_small_value(
            token_msg.amount().as_u64(),
            self.provider.get_min_deposit_sompi(),
        ) {
            Ok(TxCostEstimate {
                gas_limit: U256::MAX,
                gas_price: FixedPointNumber::from(u128::MAX),
                l2_gas_limit: None,
            })
        } else {
            Ok(TxCostEstimate {
                gas_limit: 0.into(),
                gas_price: FixedPointNumber::from(0),
                l2_gas_limit: None,
            })
        }
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
