use crate::universal_wallet_client::{utils, UniversalClient};
use crate::ConnectionConf;
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
use std::{fmt::Debug, str::FromStr};
use tracing::warn;
use url::Url;

#[derive(Clone, Debug, Deserialize)]
struct Schema<T> {
    data: Option<T>,
    _errors: Option<Errors>,
    _meta: Option<Meta>,
}

#[derive(Clone, Debug, Deserialize)]
struct Meta {
    _meta: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct Errors {
    _details: Option<Value>,
    _status: Option<u32>,
    _title: Option<String>,
}

/// Convert H256 type to String.
pub fn to_bech32(input: H256) -> ChainResult<String> {
    let hrp = Hrp::parse("sov")
        .map_err(|e| ChainCommunicationError::CustomError(format!("Failed to parse Hrp: {e:?}")))?;
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

fn from_bech32(input: &str) -> ChainResult<H256> {
    let (_, slice) = bech32::decode(input).map_err(|e| {
        ChainCommunicationError::CustomError(format!("bech32 decoding error: {e:?}"))
    })?;

    match slice.len() {
        28 => {
            let mut array = [0u8; 32];
            array[4..].copy_from_slice(&slice);
            Ok(H256::from_slice(&array))
        }
        _ => Err(ChainCommunicationError::CustomError(format!(
            "bech_32 encoding error: Address must be 28 bytes, received {slice:?}"
        ))),
    }
}

fn try_h256_to_string(input: H256) -> ChainResult<String> {
    if input[..12].iter().any(|&byte| byte != 0) {
        return Err(ChainCommunicationError::CustomError(
            "Input value exceeds size of H160".to_string(),
        ));
    }

    Ok(format!("{:?}", H160::from(input)))
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
    pub hash: String,
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
    pub hash: String,
    pub txs: Vec<Tx>,
    pub slot_number: u64,
}

/// A Sovereign Rest response payload.
#[derive(Clone, Debug, Deserialize)]
pub struct Slot {
    pub number: u64,
    pub hash: String,
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
    pub async fn new(conf: &ConnectionConf) -> ChainResult<Self> {
        let universal_wallet_client =
            utils::get_universal_client(conf.url.as_str(), conf.chain_id).await?;
        Ok(SovereignRestClient {
            url: conf.url.clone(),
            client: Client::new(),
            universal_wallet_client,
        })
    }

    /// Create a new Rest client for the Sovereign Hyperlane chain.
    pub async fn new_with_key(
        conf: &ConnectionConf,
        chain_id: u64,
        key_bytes: [u8; 32],
    ) -> ChainResult<Self> {
        let universal_wallet_client =
            utils::get_universal_client_with_key(conf.url.as_str(), chain_id, key_bytes).await?;
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

        response.data.ok_or_else(|| {
            ChainCommunicationError::CustomError(
                "Invalid response: missing batch field".to_string(),
            )
        })
    }

    pub async fn get_specified_slot(&self, slot: u64) -> ChainResult<Slot> {
        let query = format!("/ledger/slots/{slot}?children=1");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Slot> = serde_json::from_slice(&response)?;

        response.data.ok_or_else(|| {
            ChainCommunicationError::CustomError(
                "Invalid response: missing batch field".to_string(),
            )
        })
    }

    pub async fn get_tx_by_hash(&self, tx_id: String) -> ChainResult<Tx> {
        let query = format!("/ledger/txs/{tx_id}?children=1");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Tx> = serde_json::from_slice(&response)?;

        response.data.ok_or_else(|| {
            ChainCommunicationError::CustomError("Invalid response: missing tx field".to_string())
        })
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
        let data = response.data.ok_or(ChainCommunicationError::CustomError(
            "Invalid response".to_string(),
        ))?;

        Ok(data.number)
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

        let data = response.data.ok_or(ChainCommunicationError::CustomError(
            "Invalid response".to_string(),
        ))?;

        Ok(data.number)
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

        let response = response.data.unwrap_or_default();

        Ok(response)
    }

    // @Mailbox
    pub async fn get_delivered_status(&self, message_id: H256) -> ChainResult<bool> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            _value: Option<StateMap>,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct StateMap {
            _sender: Option<String>,
            _block_number: Option<u32>,
        }

        let query = format!("/modules/mailbox/state/deliveries/items/{message_id:?}");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        Ok(response.data.is_some())
    }

    // @Mailbox - test working
    pub async fn default_ism(&self) -> ChainResult<H256> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            value: Option<String>,
        }

        let query = "/modules/mailbox/state/default-ism";

        let response = self
            .http_get(query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let addr_bech32 = response.data.and_then(|d| d.value).ok_or_else(|| {
            ChainCommunicationError::CustomError(String::from("Data contained None"))
        })?;
        from_bech32(&addr_bech32)
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

        let tx_details = self.get_tx_by_hash(tx_hash.clone()).await?;
        Ok(TxOutcome {
            transaction_id: H512::from_str(&format!(
                "0x{:0>128}",
                tx_hash.trim_start_matches("0x")
            ))?,
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
            apply_tx_result: Option<ApplyTxResult>,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct ApplyTxResult {
            _receipt: Option<Receipt>,
            transaction_consumption: Option<TransactionConsumption>,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct Receipt {
            _events: Option<Vec<Events>>,
            _receipt: Option<SubReceipt>,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct Events {
            _key: Option<String>,
            _value: Option<String>,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct SubReceipt {
            _content: Option<String>,
            _outcome: Option<String>,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct TransactionConsumption {
            base_fee: Option<Vec<u32>>,
            gas_price: Option<Vec<String>>,
            _priority_fee: Option<u32>,
            _remaining_funds: Option<u32>,
        }

        let query = "/rollup/simulate";

        let json = utils::get_simulate_json_query(message, metadata, &self.universal_wallet_client)
            .await?;

        let response = self
            .http_post(query, &json)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let gas_price = FixedPointNumber::from(
            response
                .clone()
                .data
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from("data contained None"))
                })?
                .apply_tx_result
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from(
                        "apply_tx_result contained None",
                    ))
                })?
                .transaction_consumption
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from(
                        "transaction_consumption contained None",
                    ))
                })?
                .gas_price
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from("gas_price contained None"))
                })?
                .first()
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from("Failed to get item(0)"))
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
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from("data contained None"))
                })?
                .apply_tx_result
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from(
                        "apply_tx_result contained None",
                    ))
                })?
                .transaction_consumption
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from(
                        "transaction_consumption contained None",
                    ))
                })?
                .base_fee
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from("base_fee contained None"))
                })?
                .first()
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from("Failed to get item(0)"))
                })?,
        );

        let res = TxCostEstimate {
            gas_limit,
            gas_price,
            l2_gas_limit: None,
        };

        Ok(res)
    }

    // @ISM
    pub async fn dry_run(&self) -> ChainResult<Option<U256>> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            _data: Option<Value>,
        }

        let query = "/rollup/simulate";

        let json = json!(
            {
                "body":{
                    "details":{
                        "chain_id":0,
                        "max_fee":0,
                        "max_priority_fee_bips":0
                    },
                    "encoded_call_message":"",
                    "nonce":0,
                    "sender_pub_key":""
                }
            }
        );

        let response = self
            .http_post(query, &json)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Error: {e}")))?;
        let _response: Schema<Data> = serde_json::from_slice(&response)?;

        Ok(None)
    }

    // @ISM - test working
    pub async fn module_type(&self, recipient: H256) -> ChainResult<ModuleType> {
        let query = format!("/modules/mailbox/recipient-ism/{recipient:?}");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<u8> = serde_json::from_slice(&response)?;
        let module_type = response
            .data
            .ok_or_else(|| ChainCommunicationError::CustomError("Data contained None".into()))?;

        ModuleType::from_u8(module_type).ok_or_else(|| {
            ChainCommunicationError::CustomError("Unknown ModuleType returned".into())
        })
    }

    // @Merkle Tree Hook
    pub async fn tree(&self, slot: Option<u64>) -> ChainResult<IncrementalMerkle> {
        #[derive(Clone, Debug, Deserialize)]
        struct Inner {
            count: usize,
            branch: Vec<String>,
        }
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            value: Option<Inner>,
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

        if let Some(resp) = response.data.and_then(|data| data.value) {
            let count = resp.count;
            let branch = resp
                .branch
                .iter()
                .map(|hex| H256::from_str(hex))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| ChainCommunicationError::ParseError {
                    msg: format!("Couldn't parse hex: {e}"),
                })?;

            let branch_len = branch.len();
            let branch: [_; TREE_DEPTH] =
                branch
                    .try_into()
                    .map_err(|_| ChainCommunicationError::ParseError {
                        msg: format!(
                            "Invalid tree size, expected {TREE_DEPTH} elements, found {branch_len}",
                        ),
                    })?;
            Ok(IncrementalMerkle { count, branch })
        } else {
            Ok(IncrementalMerkle::default())
        }
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
        let response: Schema<u32> = serde_json::from_slice(&response)?;

        Ok(response.data.unwrap_or_default())
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
            root: String,
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
        let response = response
            .data
            .ok_or_else(|| ChainCommunicationError::ParseError {
                msg: "Response was empty".into(),
            })?;

        let response = Checkpoint {
            // sovereign implementation provides dummy address as hook is sovereign-sdk module
            merkle_tree_hook_address: H256::default(),
            mailbox_domain,
            root: H256::from_str(&response.root)?,
            index: response.index,
        };

        Ok(response)
    }

    // @MultiSig ISM
    pub async fn validators_and_threshold(&self, recipient: H256) -> ChainResult<(Vec<H256>, u8)> {
        #[derive(Debug, Deserialize)]
        struct Data {
            validators: Vec<String>,
            threshold: u8,
        }

        let query =
            format!("/modules/mailbox/recipient-ism/{recipient:?}/validators_and_threshold");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;
        let response = response.data.ok_or_else(|| {
            ChainCommunicationError::CustomError(
                "No validators and threshold found, is ISM multisig?".into(),
            )
        })?;

        let validators = response
            .validators
            .iter()
            .map(|v| H256::from_str(&format!("0x{:0>64}", v.trim_start_matches("0x"))))
            .collect::<Result<Vec<_>, _>>()?;

        Ok((validators, response.threshold))
    }

    // @Validator Announce
    pub async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            _key: Option<String>,
            value: Option<Vec<String>>,
        }

        let mut res = Vec::new();

        for (i, v) in validators.iter().enumerate() {
            res.push(vec![]);
            let validator = try_h256_to_string(*v)?;

            let query = format!("/modules/mailbox/state/validators/items/{validator}");

            let response = self.http_get(&query).await.map_err(|e| {
                ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}"))
            })?;
            let response: Schema<Data> = serde_json::from_slice(&response)?;

            if let Some(data) = response.data {
                res[i].push(String::new());
                if let Some(storage_locations) = data.value {
                    storage_locations
                        .into_iter()
                        .enumerate()
                        .for_each(|(j, storage_location)| {
                            res[i][j] = storage_location;
                        });
                }
            }
        }

        Ok(res)
    }

    // @Validator Announce
    pub async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            _key: Option<String>,
            _value: Option<Vec<String>>,
        }

        // check if already registered
        let query = format!(
            "/modules/mailbox/state/validators/items/{:?}",
            announcement.value.validator
        );

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let mut tx_outcome = TxOutcome {
            transaction_id: H512::default(),
            executed: bool::default(),
            gas_used: U256::default(),
            gas_price: FixedPointNumber::default(),
        };
        if response.data.is_none() {
            let res =
                utils::announce_validator(announcement, &self.universal_wallet_client).await?;
            tx_outcome.executed = true;
            let tx_id = &format!("0x{:0>128}", res.trim_start_matches("0x"));
            tx_outcome.transaction_id = H512::from_str(tx_id)?;
        };

        Ok(tx_outcome)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    const ISM_ADDRESS: &str = "sov1kljj6q26lwdm2mqej4tjp9j0rf5tr2afdfafg4z89ynmu0t74wc";

    #[test]
    fn test_try_h256_to_string() {
        let input =
            H256::from_str("0x00000000000000000000000014dc79964da2c08b23698b3d3cc7ca32193d9955")
                .unwrap();
        let res = try_h256_to_string(input).unwrap();
        assert_eq!(
            String::from("0x14dc79964da2c08b23698b3d3cc7ca32193d9955"),
            res
        );
    }

    #[test]
    fn test_try_h256_to_string_too_short() {
        let input =
            H256::from_str("0x000000000000000000000000000000000000000000000000000000000000beef")
                .unwrap();
        let res = try_h256_to_string(input).unwrap();
        assert_eq!(
            String::from("0x000000000000000000000000000000000000beef"),
            res
        );
    }

    #[test]
    fn test_try_h256_to_string_too_long() {
        let input =
            H256::from_str("000000000e0a2a203f9eaeb092e74d1d7bb03aa3bb03b06eee292753772e7054")
                .unwrap();
        let res = try_h256_to_string(input);
        assert!(res.is_err())
    }

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

    #[test]
    fn test_from_bech32() {
        let res = from_bech32(ISM_ADDRESS).unwrap();
        let address =
            H256::from_str("0x00000000b7e52d015afb9bb56c19955720964f1a68b1aba96a7a9454472927be")
                .unwrap();
        assert_eq!(address, res)
    }

    #[test]
    fn test_from_bech32_err() {
        let incorrect_address = "sov1kljj6q26lwdm2mqej4tyuiuhjp9j0rf5tr2afdfafg4z89ynmu0t74wc";
        assert!(from_bech32(incorrect_address).is_err())
    }
}
