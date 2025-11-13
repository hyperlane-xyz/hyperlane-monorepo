use std::sync::Arc;

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
use tracing::{error, info, warn};

// pretends to be a mailbox
#[derive(Clone, Debug)]
pub struct KaspaMailbox {
    provider: KaspaProvider,
    domain: HyperlaneDomain,
    address: H256,
}

impl KaspaMailbox {
    pub fn new(provider: KaspaProvider, locator: ContractLocator) -> ChainResult<KaspaMailbox> {
        Ok(KaspaMailbox {
            provider,
            address: locator.address,
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
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for KaspaMailbox {
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Mailbox for KaspaMailbox {
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        return Ok(0);
    }

    // Not a precise answer since actually depends on subsequent confirmation step on Kaspa,
    // so may often return false negative (says not delivered when it actually is)
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        info!(message_id = ?id, "kaspa mailbox: checking if message is delivered already, querying hub");
        let wid = WithdrawalId {
            message_id: bytes_to_hex(id.as_ref()),
        };
        let res = self
            .provider
            .hub_rpc()
            .query()
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

    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(KASPA_ISM_ADDRESS)
    }

    async fn recipient_ism(&self, _recipient: H256) -> ChainResult<H256> {
        Ok(KASPA_ISM_ADDRESS)
    }

    async fn process(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        unimplemented!("kas does not support single message processing")
    }

    fn supports_batching(&self) -> bool {
        true
    }

    // Hijacks the batch processing flow since Kaspa uses different TX submission model than EVM chains.
    // Instead of single mailbox.process() call, we build multiple Kaspa TXs that must execute in sequence.
    async fn process_batch<'a>(&self, ops: Vec<&'a QueueOperation>) -> ChainResult<BatchResult> {
        info!(
            batch_size = ops.len(),
            "kaspa mailbox: processing/submitting kaspa batch"
        );

        let msgs: Vec<HyperlaneMessage> = ops
            .iter()
            .map(|op| op.try_batch().map(|item| item.data))
            .collect::<ChainResult<Vec<HyperlaneMessage>>>()?;

        // TODO: there's not need for this, withdrawals are already tracked by the relaye using vanilla hyperlane tech
        // this is just a double storage and moreover, its not at the earliest time that the relayer actually observes the mailbox
        // on the hub..
        self.provider.hack_store_withdrawals_for_query(&msgs);

        // Cannot process withdrawals while a confirmation is pending on the Hub.
        // All operations marked failed and will be retried after confirmation completes.
        if self.provider.has_pending_confirmation() {
            return Ok(BatchResult {
                failed_indexes: (0..ops.len()).collect(),
                outcome: None,
            });
        }

        let res_processed = self
            .provider
            .process_withdrawal_messages(msgs.clone())
            .await;

        let processed_messages = match res_processed {
            Ok(results) => {
                // Store withdrawal messages using the provider's store_withdrawals method
                self.provider.add_kaspa_tx_id_withdrawals(&results);

                // Extract just the messages for further processing
                results.into_iter().map(|(msg, _)| msg).collect()
            }
            Err(e) => {
                error!(error = ?e, "kaspa mailbox: failed to process withdrawals TXs");
                Vec::new()
            }
        };

        info!("kaspa mailbox: processed withdrawals TXs");

        // Return value doesn't correspond 1:1 to what we did since we sent multiple Kaspa TXs.
        // However, since TXs must execute in sequence, we can use the last one knowing prior ones succeeded.
        // failed_indexes indicates which hyperlane messages were NOT accepted.
        let failed_idxs = {
            let mut failed = vec![];
            for (i, msg) in msgs.iter().enumerate() {
                if !processed_messages.contains(msg) {
                    failed.push(i);
                }
            }

            failed
        };

        if !failed_idxs.is_empty() {
            error!(
                failed_indexes = ?failed_idxs,
                "kaspa mailbox: processed batch with failed indexes"
            );
        }

        Ok(BatchResult {
            // outcome intentionally bogus
            outcome: Some(TxOutcome {
                transaction_id: H512::zero(),
                executed: false,
                gas_used: U256::zero(),
                gas_price: FixedPointNumber::from(0),
            }),
            failed_indexes: failed_idxs,
        })
    }

    async fn process_estimate_costs(
        &self,
        msg: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let token_msg = match TokenMessage::read_from(&mut msg.body.as_slice()) {
            Ok(msg) => msg,
            Err(_e) => {
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

    // Only used in 'lander' mode, not applicable for Kaspa bridge
    async fn process_calldata(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        todo!()
    }

    // Only used in 'lander' mode, not applicable for Kaspa bridge
    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}
