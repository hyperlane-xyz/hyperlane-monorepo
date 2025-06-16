use futures::stream::FuturesOrdered;
use futures::TryStreamExt;
use hyperlane_core::accumulator::TREE_DEPTH;
use hyperlane_core::Encode;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Announcement, ChainResult, Checkpoint,
    FixedPointNumber, HyperlaneMessage, ModuleType, SignedType, TxCostEstimate, TxOutcome, H160,
    H256, H512, U256,
};
use num_traits::FromPrimitive;
use serde::Deserialize;
use serde_json::json;

use super::client::SovereignClient;
use crate::types::{Batch, Slot, Tx};

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

    /// Get the transaction by hash
    pub async fn get_tx_by_hash(&self, tx_id: H512) -> ChainResult<Tx> {
        if tx_id.0[0..32] != [0; 32] {
            return Err(custom_err!(
                "Invalid sovereign transaction id, should have 32 bytes: {tx_id:?}"
            ));
        }
        let tx_id = H256(tx_id[32..].try_into().expect("Must be 32 bytes"));

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
        let query = match at_height {
            None => "/modules/mailbox/nonce",
            Some(slot) => &format!("/modules/mailbox/nonce?slot_number={slot}"),
        };

        Ok(self.http_get::<u32>(query).await?)
    }

    /// Check if message with given id was delivered
    pub async fn delivered(&self, message_id: H256) -> ChainResult<bool> {
        let query = format!("/modules/mailbox/state/deliveries/items/{message_id:?}");

        match self.http_get::<()>(&query).await {
            Ok(_) => Ok(true),
            Err(e) if e.is_not_found() => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Submit a message for processing in the rollup
    pub async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        // Estimate the costs to get the price
        let gas_price = self
            .process_estimate_costs(message, metadata)
            .await?
            .gas_price;

        let call_message = json!({
            "mailbox": {
                "process": {
                    "metadata": metadata.to_vec(),
                    "message": message.to_vec(),
                }
            },
        });
        let (tx_hash, _) = self.build_and_submit(call_message).await?;

        let tx_details = self.get_tx_by_hash(tx_hash.into()).await?;

        Ok(TxOutcome {
            transaction_id: tx_details.hash.into(),
            executed: tx_details.receipt.result == "successful",
            gas_used: match tx_details.receipt.data.gas_used.first() {
                Some(v) => U256::from(*v),
                None => U256::default(),
            },
            gas_price,
        })
    }

    /// Estimate the cost of submitting process transaction
    pub async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            apply_tx_result: ApplyTxResult,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct ApplyTxResult {
            receipt: Receipt,
            transaction_consumption: TransactionConsumption,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct Receipt {
            receipt: ReceiptInner,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct ReceiptInner {
            outcome: String,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct TransactionConsumption {
            base_fee: Vec<u32>,
            gas_price: Vec<String>,
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

        let encoded_call_message = self.encoded_call_message(&call_message)?;
        let json = json!({
            "body": {
              "details":{
                "chain_id": message.destination,
                "max_fee": "100000000",
                "max_priority_fee_bips": 0
              },
              "encoded_call_message": encoded_call_message,
              "nonce": message.nonce,
              "generation": 0,
              "sender_pub_key": "\"f8ad2437a279e1c8932c07358c91dc4fe34864a98c6c25f298e2a0199c1509ff\""
            }
        });

        let response = self.http_post::<Data>(query, &json).await?;

        let receipt = response.apply_tx_result.receipt;
        if receipt.receipt.outcome != "successful" {
            return Err(custom_err!("Transaction simulation reverted"));
        }

        let gas_price = FixedPointNumber::from(
            response
                .apply_tx_result
                .transaction_consumption
                .gas_price
                .first()
                .ok_or_else(|| custom_err!("Failed to get item(0)"))?
                .parse::<u32>()
                .map_err(|e| custom_err!("Failed to parse gas_price: {e:?}"))?,
        );

        let gas_limit = U256::from(
            *response
                .apply_tx_result
                .transaction_consumption
                .base_fee
                .first()
                .ok_or_else(|| custom_err!("Failed to get item(0)"))?,
        );

        let res = TxCostEstimate {
            gas_limit,
            gas_price,
            l2_gas_limit: None,
        };

        Ok(res)
    }

    /// Get the type of the ISM of given recipient
    pub async fn module_type(&self, recipient: H256) -> ChainResult<ModuleType> {
        let query = format!("/modules/mailbox/recipient-ism/{recipient:?}");

        let response = self.http_get::<u8>(&query).await?;

        ModuleType::from_u8(response).ok_or_else(|| custom_err!("Unknown ModuleType returned"))
    }

    /// Get the merkle tree of dispatched messages
    pub async fn tree(&self, slot: Option<u64>) -> ChainResult<IncrementalMerkle> {
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
        Ok(IncrementalMerkle {
            count: response.value.count,
            branch,
        })
    }

    /// Get the count of messages inserted into merkle tree hook
    pub async fn tree_count(&self, at_height: Option<u64>) -> ChainResult<u32> {
        let query = match at_height {
            None => "modules/merkle-tree-hook/count",
            Some(slot) => &format!("modules/merkle-tree-hook/count?slot_number={slot}"),
        };

        match self.http_get::<u32>(query).await {
            Ok(count) => Ok(count),
            Err(e) if e.is_not_found() => Ok(0),
            Err(e) => Err(e.into()),
        }
    }

    /// Get the checkpoint of a merkle tree hook
    pub async fn latest_checkpoint(
        &self,
        at_height: Option<u64>,
        mailbox_domain: u32,
    ) -> ChainResult<Checkpoint> {
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

        let response = Checkpoint {
            // sovereign implementation provides dummy address as hook is sovereign-sdk module
            merkle_tree_hook_address: H256::default(),
            mailbox_domain,
            root: response.root,
            index: response.index,
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
            transaction_id: res.0.into(),
            executed: true,
            gas_used: U256::default(),
            gas_price: FixedPointNumber::default(),
        })
    }
}
