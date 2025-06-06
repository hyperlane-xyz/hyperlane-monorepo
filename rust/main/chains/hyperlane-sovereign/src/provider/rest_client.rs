use crate::universal_wallet_client::{utils, UniversalClient};
use crate::{ConnectionConf, Signer};
use bech32::{Bech32m, Hrp};
use bytes::Bytes;
use hyperlane_core::accumulator::TREE_DEPTH;
use hyperlane_core::Encode;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Announcement, ChainCommunicationError,
    ChainResult, Checkpoint, FixedPointNumber, HyperlaneMessage, ModuleType, SignedType,
    TxCostEstimate, TxOutcome, H160, H256, H512, U256,
};
use num_traits::FromPrimitive;
use reqwest::StatusCode;
use reqwest::{header::HeaderMap, Client, Response};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt::Debug;
use tracing::warn;
use url::Url;

#[derive(Clone, Debug, Deserialize)]
struct Schema<T> {
    data: T,
}

#[derive(Clone, Debug, Deserialize)]
struct Data;

/// Convert H256 type to String.
pub fn to_bech32(input: H256) -> ChainResult<String> {
    let hrp = Hrp::parse("sov").expect("Hardcoded HRP");
    let mut bech32_address = String::new();
    let addr = input.as_ref();

    let addr = if addr.len() == 28 {
        addr
    } else if addr.len() == 32 && addr[..4] == [0, 0, 0, 0] {
        &addr[4..]
    } else {
        return Err(ChainCommunicationError::CustomError(format!(
            "bech_32 encoding error: Address must be 28 bytes, received {addr:?}"
        )));
    };
    bech32::encode_to_fmt::<Bech32m, String>(&mut bech32_address, hrp, addr).map_err(|e| {
        ChainCommunicationError::CustomError(format!("bech32 encoding error: {e:?}"))
    })?;
    Ok(bech32_address)
}

#[derive(Clone, Debug)]
pub struct SovereignRestClient {
    url: Url,
    client: Client,
    universal_wallet_client: UniversalClient,
}

/// A Sovereign Rest response payload.
#[derive(Clone, Debug, Deserialize)]
pub struct TxEvent {
    pub key: String,
    pub value: serde_json::Value,
    pub number: u64,
}

/// A Sovereign Rest response payload.
#[derive(Clone, Debug, Deserialize)]
pub struct Tx {
    pub number: u64,
    pub hash: H256,
    pub events: Vec<TxEvent>,
    pub batch_number: u64,
    pub receipt: Receipt,
}

/// A Sovereign Rest response payload.
#[derive(Clone, Debug, Deserialize)]
pub struct Receipt {
    pub result: String,
    pub data: TxData,
}

/// A Sovereign Rest response payload.
#[derive(Clone, Debug, Deserialize)]
pub struct TxData {
    pub gas_used: Vec<u32>,
}

/// A Sovereign Rest response payload.
#[derive(Clone, Debug, Deserialize)]
pub struct Batch {
    pub number: u64,
    pub hash: H256,
    pub txs: Vec<Tx>,
    pub slot_number: u64,
}

/// A Sovereign Rest response payload.
#[derive(Clone, Debug, Deserialize)]
pub struct Slot {
    pub number: u64,
    pub hash: H256,
    pub batches: Vec<Batch>,
}

impl SovereignRestClient {
    async fn http_get(&self, query: &str) -> Result<Bytes, reqwest::Error> {
        let mut header_map = HeaderMap::default();
        header_map.insert(
            "content-type",
            "application/json".parse().expect("Well-formed &str"),
        );

        let response = self
            .client
            .get(format!("{}{}", &self.url, query))
            .headers(header_map)
            .send()
            .await?;

        let result = self.parse_response(response).await?;
        warn!("HTTP GET: {query}; {}", String::from_utf8_lossy(&result));
        Ok(result)
    }

    async fn http_post(&self, query: &str, json: &Value) -> Result<Bytes, reqwest::Error> {
        let mut header_map = HeaderMap::default();
        header_map.insert(
            "content-type",
            "application/json".parse().expect("Well-formed &str"),
        );

        let response = self
            .client
            .post(format!("{}{}", &self.url, query))
            .headers(header_map)
            .json(json)
            .send()
            .await?;

        let result = self.parse_response(response).await?;

        warn!(
            "HTTP POST: {query}; {json:?}; {}",
            String::from_utf8_lossy(&result)
        );
        Ok(result)
    }

    async fn parse_response(&self, response: Response) -> Result<Bytes, reqwest::Error> {
        match response.status() {
            StatusCode::OK => {
                // 200
                let response = response.bytes().await?;
                Ok(response)
            }
            StatusCode::BAD_REQUEST => {
                // 400
                let response = response.bytes().await?;
                Ok(response)
            }
            StatusCode::NOT_FOUND => {
                // 404
                let response = response.bytes().await?;
                Ok(response)
            }
            _ => {
                response.error_for_status_ref()?;
                let bytes = response.bytes().await?; // Extract the body as Bytes
                Ok(bytes)
            }
        }
    }

    /// Create a new Rest client for the Sovereign Hyperlane chain.
    pub async fn new(conf: &ConnectionConf, signer: Signer) -> ChainResult<Self> {
        let universal_wallet_client =
            UniversalClient::new(conf.url.as_str(), signer, conf.chain_id)
                .await
                .map_err(|e| {
                    ChainCommunicationError::CustomError(format!(
                        "Failed to create Universal Client: {e:?}"
                    ))
                })?;
        Ok(SovereignRestClient {
            url: conf.url.clone(),
            client: Client::new(),
            universal_wallet_client,
        })
    }

    pub async fn get_batch(&self, batch: u64) -> ChainResult<Batch> {
        let query = format!("/ledger/batches/{batch}?children=1");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Batch> = serde_json::from_slice(&response)?;

        Ok(response.data)
    }

    pub async fn get_specified_slot(&self, slot: u64) -> ChainResult<Slot> {
        let query = format!("/ledger/slots/{slot}?children=1");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Slot> = serde_json::from_slice(&response)?;

        Ok(response.data)
    }

    pub async fn get_tx_by_hash(&self, tx_id: H512) -> ChainResult<Tx> {
        if tx_id.0[0..32] != [0; 32] {
            return Err(ChainCommunicationError::CustomError(format!(
                "Invalid sovereign transaction id, should have 32 bytes: {tx_id:?}"
            )));
        }
        let tx_id = H256(tx_id[32..].try_into().expect("Must be 32 bytes"));

        let query = format!("/ledger/txs/{tx_id:?}?children=1");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Tx> = serde_json::from_slice(&response)?;

        Ok(response.data)
    }

    // Return the latest slot.
    pub async fn get_latest_slot(&self) -> ChainResult<u64> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            number: u64,
        }
        let query = "/ledger/slots/latest?children=0";
        let response = self
            .http_get(query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        Ok(response.data.number)
    }

    // Return the finalized slot
    pub async fn get_finalized_slot(&self) -> ChainResult<u64> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            number: u64,
        }
        let query = "/ledger/slots/finalized?children=0";
        let response = self
            .http_get(query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        Ok(response.data.number)
    }

    // @Mailbox
    pub async fn get_count(&self, at_height: Option<u64>) -> ChainResult<u32> {
        let query = match at_height {
            None => "/modules/mailbox/nonce",
            Some(slot) => &format!("/modules/mailbox/nonce?slot_number={slot}"),
        };

        let response = self
            .http_get(query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<u32> = serde_json::from_slice(&response)?;

        Ok(response.data)
    }

    // @Mailbox
    pub async fn get_delivered_status(&self, message_id: H256) -> ChainResult<bool> {
        let query = format!("/modules/mailbox/state/deliveries/items/{message_id:?}");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Result<Schema<Data>, serde_json::Error> = serde_json::from_slice(&response);
        Ok(response.is_ok())
    }

    // @Mailbox - test working
    pub async fn default_ism(&self) -> ChainResult<H256> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            value: H256,
        }

        let query = "/modules/mailbox/state/default-ism";

        let response = self
            .http_get(query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        Ok(response.data.value)
    }

    // @Mailbox
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
        let (tx_hash, _) = self
            .universal_wallet_client
            .build_and_submit(call_message)
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to submit process transaction: {e}"
                ))
            })?;
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

    // @Mailbox
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

        let json = utils::get_simulate_json_query(message, metadata, &self.universal_wallet_client)
            .await?;

        let response = self
            .http_post(query, &json)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let receipt = response.data.apply_tx_result.receipt;
        if receipt.receipt.outcome != "successful" {
            return Err(ChainCommunicationError::CustomError(
                "Transaction simulation reverted".into(),
            ));
        }

        let gas_price = FixedPointNumber::from(
            response
                .data
                .apply_tx_result
                .transaction_consumption
                .gas_price
                .first()
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError("Failed to get item(0)".into())
                })?
                .parse::<u32>()
                .map_err(|e| {
                    ChainCommunicationError::CustomError(format!(
                        "Failed to parse gas_price: {e:?}"
                    ))
                })?,
        );

        let gas_limit = U256::from(
            *response
                .data
                .apply_tx_result
                .transaction_consumption
                .base_fee
                .first()
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError("Failed to get item(0)".into())
                })?,
        );

        let res = TxCostEstimate {
            gas_limit,
            gas_price,
            l2_gas_limit: None,
        };

        Ok(res)
    }

    // @ISM - test working
    pub async fn module_type(&self, recipient: H256) -> ChainResult<ModuleType> {
        let query = format!("/modules/mailbox/recipient-ism/{recipient:?}");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<u8> = serde_json::from_slice(&response)?;

        ModuleType::from_u8(response.data).ok_or_else(|| {
            ChainCommunicationError::CustomError("Unknown ModuleType returned".into())
        })
    }

    // @Merkle Tree Hook
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

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let branch = response.data.value.branch;

        let branch_len = branch.len();
        let branch: [_; TREE_DEPTH] =
            branch
                .try_into()
                .map_err(|_| ChainCommunicationError::ParseError {
                    msg: format!(
                        "Invalid tree size, expected {TREE_DEPTH} elements, found {branch_len}",
                    ),
                })?;
        Ok(IncrementalMerkle {
            count: response.data.value.count,
            branch,
        })
    }

    // @Merkle Tree Hook
    pub async fn tree_count(&self, at_height: Option<u64>) -> ChainResult<u32> {
        let query = match at_height {
            None => "modules/merkle-tree-hook/count",
            Some(slot) => &format!("modules/merkle-tree-hook/count?slot_number={slot}"),
        };

        let response = self
            .http_get(query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Result<Schema<u32>, serde_json::Error> = serde_json::from_slice(&response);
        Ok(response.map(|res| res.data).unwrap_or_default())
    }

    // @Merkle Tree Hook
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

        let response = self
            .http_get(query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let response = Checkpoint {
            // sovereign implementation provides dummy address as hook is sovereign-sdk module
            merkle_tree_hook_address: H256::default(),
            mailbox_domain,
            root: response.data.root,
            index: response.data.index,
        };

        Ok(response)
    }

    // @MultiSig ISM
    pub async fn validators_and_threshold(&self, recipient: H256) -> ChainResult<(Vec<H256>, u8)> {
        #[derive(Debug, Deserialize)]
        struct Data {
            validators: Vec<H160>,
            threshold: u8,
        }

        let query =
            format!("/modules/mailbox/recipient-ism/{recipient:?}/validators_and_threshold");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let validators = response
            .data
            .validators
            .iter()
            .map(|v| H256::from(*v))
            .collect();

        Ok((validators, response.data.threshold))
    }

    // @Validator Announce
    pub async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            value: Vec<String>,
        }

        let mut res = Vec::new();

        for (i, v) in validators.iter().enumerate() {
            res.push(vec![]);
            let validator = H160::from(*v);
            let query = format!("/modules/mailbox/state/validators/items/{validator:?}");

            let response = self.http_get(&query).await.map_err(|e| {
                ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}"))
            })?;
            let response: Result<Schema<Data>, serde_json::Error> =
                serde_json::from_slice(&response);

            if let Ok(response) = response {
                res[i].push(String::new());
                response
                    .data
                    .value
                    .into_iter()
                    .enumerate()
                    .for_each(|(j, storage_location)| {
                        res[i][j] = storage_location;
                    });
            }
        }

        Ok(res)
    }

    // @Validator Announce
    pub async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let result = utils::announce_validator(announcement, &self.universal_wallet_client).await?;

        // Upstream logic is only concerned with `executed` status is we've made it this far.
        Ok(TxOutcome {
            transaction_id: result.into(),
            executed: true,
            gas_used: U256::default(),
            gas_price: FixedPointNumber::default(),
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use std::str::FromStr;

    const ISM_ADDRESS: &str = "sov1kljj6q26lwdm2mqej4tjp9j0rf5tr2afdfafg4z89ynmu0t74wc";

    #[test]
    fn test_to_bech32_left_padded_ok() {
        let address =
            H256::from_str("0x00000000b7e52d015afb9bb56c19955720964f1a68b1aba96a7a9454472927be")
                .unwrap();
        let res = to_bech32(address).unwrap();
        let address = String::from(ISM_ADDRESS);
        assert_eq!(address, res)
    }

    #[test]
    fn test_to_bech32_right_padded_err() {
        let address =
            H256::from_str("0xb7e52d015afb9bb56c19955720964f1a68b1aba96a7a9454472927be00000000")
                .unwrap();
        assert!(to_bech32(address).is_err())
    }
}
