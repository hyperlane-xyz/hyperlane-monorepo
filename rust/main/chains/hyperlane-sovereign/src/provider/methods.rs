use futures::stream::FuturesOrdered;
use futures::TryStreamExt;
use hyperlane_core::accumulator::TREE_DEPTH;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Announcement, ChainResult, Checkpoint,
    FixedPointNumber, HyperlaneMessage, ModuleType, SignedType, TxCostEstimate, TxOutcome, H160,
    H256, U256,
};
use hyperlane_core::{CheckpointAtBlock, Encode, IncrementalMerkleAtBlock};
use num_traits::FromPrimitive;
use serde::Deserialize;
use serde_json::json;

use super::client::SovereignClient;
use crate::types::{Batch, Slot, Tx, TxResult};
use crate::Crypto;

impl SovereignClient {
    /// Get the batch by number
    pub async fn get_batch(&self, batch: u64) -> ChainResult<Batch> {
        let query = format!("/ledger/batches/{batch}?children=1");

        Ok(self.http_get::<Batch>(&query).await?)
    }

    /// Get the slot by number
    pub async fn get_specified_slot(&self, slot: u64) -> ChainResult<Slot> {
        let query = format!("/ledger/slots/{slot}?children=1");

        Ok(self.http_get::<Slot>(&query).await?)
    }

    pub async fn get_tx_by_hash(&self, tx_id: H256) -> ChainResult<Tx> {
        let query = format!("/ledger/txs/{tx_id:?}?children=1");

        Ok(self.http_get::<Tx>(&query).await?)
    }

    /// Return the latest slot.
    pub async fn get_latest_slot(&self) -> ChainResult<u64> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            number: u64,
        }
        let query = "/ledger/slots/latest?children=0";

        Ok(self.http_get::<Data>(query).await?.number)
    }

    /// Return the finalized slot
    pub async fn get_finalized_slot(&self) -> ChainResult<u64> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            number: u64,
        }
        let query = "/ledger/slots/finalized?children=0";

        Ok(self.http_get::<Data>(query).await?.number)
    }

    /// Get the count of dispatched messages in Mailbox
    pub async fn get_count(&self, at_height: Option<u64>) -> ChainResult<u32> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            nonce: u32,
        }
        let query = match at_height {
            None => "/modules/mailbox/nonce",
            Some(slot) => &format!("/modules/mailbox/nonce?slot_number={slot}"),
        };

        Ok(self.http_get::<Data>(query).await?.nonce)
    }

    /// Check if message with given id was delivered
    pub async fn delivered(&self, message_id: H256) -> ChainResult<bool> {
        let query = format!("/modules/mailbox/state/deliveries/items/{message_id:?}");

        match self.http_get::<serde_json::Value>(&query).await {
            Ok(_) => Ok(true),
            Err(e) if e.is_not_found() => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Get the balance of the native gas token of the provided address.
    pub async fn get_balance(&self, address: impl AsRef<str>) -> ChainResult<U256> {
        #[derive(Debug, Deserialize)]
        struct Data {
            amount: String,
        }

        let query = format!(
            "/modules/bank/tokens/gas_token/balances/{}",
            address.as_ref()
        );

        Ok(self
            .http_get::<Data>(&query)
            .await
            .map(|res| U256::from_dec_str(&res.amount))??)
    }

    /// Submit a message for processing in the rollup
    pub async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let call_message = json!({
            "mailbox": {
                "process": {
                    "metadata": metadata.to_vec(),
                    "message": message.to_vec(),
                }
            },
        });
        let (result, _) = self.build_and_submit(call_message).await?;

        let tx_details = self.get_tx_by_hash(result.id).await?;
        let gas_used = U256::from(
            tx_details
                .receipt
                .data
                .gas_used
                .into_iter()
                .map(u128::from)
                .sum::<u128>(),
        );

        Ok(TxOutcome {
            transaction_id: tx_details.hash.into(),
            executed: matches!(tx_details.receipt.result, TxResult::Successful),
            gas_used,
            gas_price: FixedPointNumber::default(),
        })
    }

    /// Estimate the cost of submitting process transaction
    pub async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        #[derive(Debug, Clone, Deserialize)]
        struct SuccessOutcome {
            gas_used: String,
            priority_fee: String,
        }

        #[derive(Debug, Clone, Deserialize)]
        pub struct FailOutcome {
            reason: String,
        }

        #[derive(Debug, Clone, Deserialize)]
        #[serde(tag = "outcome", rename_all = "snake_case")]
        enum SimulateOutcome {
            Success(SuccessOutcome),
            Reverted(FailOutcome),
            Skipped(FailOutcome),
        }

        let query = "/rollup/simulate";
        let call_message = json!({
            "mailbox": {
                "process": {
                    "metadata": metadata.to_vec(),
                    "message": message.to_vec(),
                }
            },
        });
        let request = json!({
            "sender": hex::encode(self.signer.credential_id()),
            "call": call_message,
        });

        let outcome = self.http_post::<SimulateOutcome>(query, &request).await?;

        match outcome {
            SimulateOutcome::Success(success_outcome) => {
                let priority_fee = success_outcome.priority_fee.parse::<u128>()?;
                let gas_used = success_outcome.gas_used.parse::<u128>()?;
                Ok(TxCostEstimate {
                    gas_limit: (priority_fee + gas_used).into(),
                    gas_price: Default::default(),
                    l2_gas_limit: None,
                })
            }
            SimulateOutcome::Reverted(fail_outcome) | SimulateOutcome::Skipped(fail_outcome) => {
                Err(custom_err!(
                    "Transaction simulation failed, reason: {}",
                    fail_outcome.reason
                ))
            }
        }
    }

    /// Get the type of the ISM of given recipient
    pub async fn module_type(&self, recipient: H256) -> ChainResult<ModuleType> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            ism_kind: u8,
        }
        let query = format!("/modules/mailbox/recipient-ism/{recipient:?}");

        let response = self.http_get::<Data>(&query).await?;
        let module_type = response.ism_kind;

        ModuleType::from_u8(module_type)
            .ok_or_else(|| custom_err!("Unknown ModuleType returned: {module_type}"))
    }

    /// Get the merkle tree of dispatched messages
    pub async fn tree(&self, slot: Option<u64>) -> ChainResult<IncrementalMerkleAtBlock> {
        #[derive(Clone, Debug, Deserialize)]
        struct Inner {
            count: usize,
            branch: Vec<H256>,
        }
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            value: Inner,
        }

        let query = match slot {
            None => "modules/merkle-tree-hook/state/tree".into(),
            Some(slot) => {
                format!("modules/merkle-tree-hook/state/tree?slot_number={slot}")
            }
        };

        let response = self.http_get::<Data>(&query).await?;

        let branch = response.value.branch;

        let branch_len = branch.len();
        let branch: [_; TREE_DEPTH] = branch.try_into().map_err(|_| {
            custom_err!("Invalid tree size, expected {TREE_DEPTH} elements, found {branch_len}")
        })?;
        Ok(IncrementalMerkleAtBlock {
            tree: IncrementalMerkle {
                count: response.value.count,
                branch,
            },
            block_height: slot,
        })
    }

    /// Get the count of messages inserted into merkle tree hook
    pub async fn tree_count(&self, at_height: Option<u64>) -> ChainResult<u32> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            count: u32,
        }

        let query = match at_height {
            None => "modules/merkle-tree-hook/count",
            Some(slot) => &format!("modules/merkle-tree-hook/count?slot_number={slot}"),
        };

        match self.http_get::<Data>(query).await {
            Ok(response) => Ok(response.count),
            Err(e) if e.is_not_found() => Ok(0),
            Err(e) => Err(e.into()),
        }
    }

    /// Get the checkpoint of a merkle tree hook
    pub async fn latest_checkpoint(
        &self,
        at_height: Option<u64>,
        mailbox_domain: u32,
    ) -> ChainResult<CheckpointAtBlock> {
        #[derive(Debug, Deserialize)]
        struct Data {
            index: u32,
            root: H256,
        }

        let query = match at_height {
            None => "modules/merkle-tree-hook/checkpoint",
            Some(slot) => &format!("modules/merkle-tree-hook/checkpoint?slot_number={slot}"),
        };

        let response = self.http_get::<Data>(query).await?;

        let response = CheckpointAtBlock {
            checkpoint: Checkpoint {
                // sovereign implementation provides dummy address as hook is sovereign-sdk module
                merkle_tree_hook_address: H256::default(),
                mailbox_domain,
                root: response.root,
                index: response.index,
            },
            block_height: at_height,
        };

        Ok(response)
    }

    /// Get trusted validators and required signature threshold of recipient's multisig-ism
    pub async fn validators_and_threshold(&self, recipient: H256) -> ChainResult<(Vec<H256>, u8)> {
        #[derive(Debug, Deserialize)]
        struct Data {
            validators: Vec<H160>,
            threshold: u8,
        }
        let query =
            format!("/modules/mailbox/recipient-ism/{recipient:?}/validators_and_threshold");

        let response = self.http_get::<Data>(&query).await?;

        let validators = response.validators.iter().map(|v| H256::from(*v)).collect();

        Ok((validators, response.threshold))
    }

    /// Get the signature locations of given validators
    pub async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            value: Vec<String>,
        }

        let futs = validators
            .iter()
            .map(|val_addr| async move {
                let val_addr = H160::from(*val_addr);
                let query = format!("/modules/mailbox/state/validators/items/{val_addr:?}");

                match self.http_get::<Data>(&query).await {
                    Ok(locations) => Ok(locations.value),
                    Err(e) if e.is_not_found() => Ok(vec![]),
                    Err(e) => Err(e),
                }
            })
            .collect::<FuturesOrdered<_>>();

        Ok(futs.try_collect().await?)
    }

    /// Announce validator on chain
    pub async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let sig_bytes: [u8; 65] = announcement.signature.into();
        let call_message = json!({
            "mailbox": {
                "announce": {
                    "validator_address": announcement.value.validator,
                    "storage_location": announcement.value.storage_location,
                    "signature": format!("0x{}", hex::encode(sig_bytes)),
                }
            },
        });

        let res = self.build_and_submit(call_message).await?;

        // Upstream logic is only concerned with `executed` status is we've made it this far.
        Ok(TxOutcome {
            transaction_id: res.0.id.into(),
            executed: true,
            gas_used: U256::default(),
            gas_price: FixedPointNumber::default(),
        })
    }
}
