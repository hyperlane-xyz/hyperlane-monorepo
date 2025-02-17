use crate::universal_wallet_client::{utils, UniversalClient};
use crate::ConnectionConf;
use bech32::{Bech32m, Hrp};
use bytes::Bytes;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Announcement, BlockInfo, ChainCommunicationError,
    ChainInfo, ChainResult, Checkpoint, FixedPointNumber, HyperlaneMessage, ModuleType,
    RawHyperlaneMessage, SignedType, TxCostEstimate, TxOutcome, TxnInfo, TxnReceiptInfo, H160,
    H256, H512, U256,
};
use reqwest::StatusCode;
use reqwest::{header::HeaderMap, Client, Response};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fmt::Debug, str::FromStr};
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

    match addr.len() {
        28 => {
            bech32::encode_to_fmt::<Bech32m, String>(&mut bech32_address, hrp, addr).map_err(
                |e| ChainCommunicationError::CustomError(format!("bech32 encoding error: {e:?}")),
            )?;

            Ok(bech32_address)
        }
        32 if addr[..4] == [0, 0, 0, 0] => {
            bech32::encode_to_fmt::<Bech32m, String>(&mut bech32_address, hrp, &addr[4..])
                .map_err(|e| {
                    ChainCommunicationError::CustomError(format!("bech32 encoding error: {e:?}"))
                })?;

            Ok(bech32_address)
        }
        _ => Err(ChainCommunicationError::CustomError(format!(
            "bech_32 encoding error: Address must be 28 bytes, received {addr:?}"
        ))),
    }
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

fn try_h512_to_h256(input: H512) -> ChainResult<H256> {
    if input[..32] != [0; 32] {
        return Err(ChainCommunicationError::CustomError(String::from(
            "Invalid input length",
        )));
    }

    let bytes = &input[32..];
    Ok(H256::from_slice(bytes))
}

#[derive(Clone, Debug)]
pub(crate) struct SovereignRestClient {
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
}

/// A Sovereign Rest response payload.
#[derive(Clone, Debug, Deserialize)]
pub struct Batch {
    pub number: u64,
    pub hash: String,
    pub txs: Vec<Tx>,
    pub slot_number: u64,
}
trait HttpClient {
    async fn http_get(&self, query: &str) -> Result<Bytes, reqwest::Error>;
    async fn http_post(&self, query: &str, json: &Value) -> Result<Bytes, reqwest::Error>;
    async fn parse_response(&self, response: Response) -> Result<Bytes, reqwest::Error>;
}

impl HttpClient for SovereignRestClient {
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
}

impl SovereignRestClient {
    /// Create a new Rest client for the Sovereign Hyperlane chain.
    pub async fn new(conf: &ConnectionConf, domain: u32) -> ChainResult<Self> {
        let universal_wallet_client =
            utils::get_universal_client(conf.url.as_str(), domain).await?;
        Ok(SovereignRestClient {
            url: conf.url.clone(),
            client: Client::new(),
            universal_wallet_client,
        })
    }

    pub async fn get_values_from_key(&self, key: &str) -> ChainResult<String> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            _key: Option<String>,
            value: Option<Vec<String>>,
        }

        // /modules/accounts/state/credential-ids/items/{key}
        let query = format!("/modules/accounts/state/credential-ids/items/{key}");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let response = response.data.clone().and_then(|d| d.value).ok_or_else(|| {
            ChainCommunicationError::CustomError(String::from("Data contained None"))
        })?;

        if response.is_empty() {
            Err(ChainCommunicationError::CustomError(String::from(
                "Received empty list",
            )))
        } else {
            Ok(response
                .first()
                .ok_or(ChainCommunicationError::CustomError(String::from(
                    "Failed to get first item",
                )))?
                .clone())
        }
    }

    pub async fn get_nonce(&self, key: &str) -> ChainResult<u32> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            _key: Option<String>,
            value: Option<u32>,
        }

        // /modules/nonces/state/nonces/items/{key}
        let query = format!("/modules/nonces/state/nonces/items/{key}");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let response = response.data.and_then(|d| d.value).ok_or_else(|| {
            ChainCommunicationError::CustomError(String::from("Data contained None"))
        })?;
        Ok(response)
    }

    // @Provider
    pub async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            #[serde(rename = "type")]
            _sovereign_type: Option<String>,
            number: Option<u64>,
            hash: Option<String>,
            _event_range: Option<EventRange>,
            _receipt: Option<Value>,
            _body: Option<String>,
            _events: Option<Value>,
            _batch_number: Option<u32>,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct EventRange {
            _start: Option<u32>,
            _end: Option<u32>,
        }

        // /ledger/slots/{slotId}
        let children = 0;
        let query = format!("/ledger/slots/{height:?}?children={children}");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        if let Some(response_data) = response.data {
            if let (Some(hash), Some(number)) = (response_data.hash, response_data.number) {
                Ok(BlockInfo {
                    hash: H256::from_str(hash.as_str())?,
                    timestamp: u64::default(),
                    number,
                })
            } else {
                Err(ChainCommunicationError::CustomError(String::from(
                    "Bad response",
                )))
            }
        } else {
            Err(ChainCommunicationError::CustomError(String::from(
                "Bad response",
            )))
        }
    }

    // @Provider
    pub async fn get_txn_by_hash(&self, height: &H512) -> ChainResult<TxnInfo> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            id: Option<String>,
            _status: Option<String>,
        }

        let height = try_h512_to_h256(*height)?;

        // /sequencer/txs/{txHash}
        let query = format!("/sequencer/txs/{height:?}");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let res = TxnInfo {
            hash: H512::from_str(
                response
                    .data
                    .and_then(|d| d.id)
                    .ok_or(ChainCommunicationError::CustomError(
                        "Invalid response".to_string(),
                    ))?
                    .as_str(),
            )?,
            gas_limit: U256::default(),
            max_priority_fee_per_gas: Some(U256::default()),
            max_fee_per_gas: Some(U256::default()),
            gas_price: Some(U256::default()),
            nonce: u64::default(),
            sender: H256::default(),
            recipient: Some(H256::default()),
            receipt: Some(TxnReceiptInfo {
                gas_used: U256::default(),
                cumulative_gas_used: U256::default(),
                effective_gas_price: Some(U256::default()),
            }),
            raw_input_data: None,
        };
        Ok(res)
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

    async fn get_compensated_rollup_height(&self, lag: u64) -> ChainResult<u64> {
        let (_, latest_batch) = self.get_latest_slot().await?;
        let batch = self
            .get_batch(
                latest_batch
                    .ok_or(ChainCommunicationError::CustomError(String::from(
                        "latest batch was None",
                    )))?
                    .into(),
            )
            .await?;
        batch.slot_number.checked_sub(lag).ok_or_else(|| {
            ChainCommunicationError::CustomError("lag was greater than rollup height".to_string())
        })
    }

    // Return the latest slot, and the highest committed batch number in that slot.
    pub async fn get_latest_slot(&self) -> ChainResult<(u32, Option<u32>)> {
        #[derive(Clone, Debug, Deserialize)]
        struct BatchRange {
            // start: u32,
            end: u32,
        }
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            batch_range: BatchRange,
            number: u32,
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

        // bach_range.end is exclusive - it's one above the last committed batch number
        let last_batch = data.batch_range.end.checked_sub(1);

        Ok((data.number, last_batch))
    }

    // @Provider - test working, need to test all variants
    pub async fn is_contract(&self, key: H256) -> ChainResult<bool> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            key: Option<String>,
            _value: Option<String>,
        }

        for module in [
            "mailbox-hook-registry",
            "mailbox-ism-registry",
            "mailbox-recipient-registry",
        ] {
            let query = format!(
                "/modules/{}/state/registry/items/{}",
                module,
                to_bech32(key)?
            );

            let response = self.http_get(&query).await.map_err(|e| {
                ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}"))
            })?;
            let response: Schema<Data> = serde_json::from_slice(&response)?;

            if response.data.and_then(|data| data.key).is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    // @Provider
    pub fn get_balance(&self, _token_id: &str, _address: &str) -> ChainResult<U256> {
        // // /modules/bank/tokens/{token_id}/balances/{address}
        // let query = format!("/modules/bank/tokens/{}/balances/{}", token_id, address);

        // #[derive(Clone, Debug, Deserialize)]
        // struct Data {
        //     _amount: Option<u128>,
        //     _token_id: Option<String>,
        // }

        // let response = self
        //     .http_get(&query)
        //     .await
        //     .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {}", e)))?;
        // let response: Schema<Data> = serde_json::from_slice(&response)?;

        // let response = U256::from(response);
        Ok(U256::default())
    }

    // @Provider
    pub fn _get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        todo!("Not yet implemented")
    }

    // @Mailbox
    pub async fn get_count(&self, at_height: Option<u32>) -> ChainResult<u32> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            value: Option<u32>,
        }

        // /modules/mailbox/state/nonce
        let query: String = match at_height {
            Some(0) | None => "/modules/mailbox/state/nonce".to_owned(),
            Some(lag) => {
                let rollup_height = self.get_compensated_rollup_height(u64::from(lag)).await?;
                format!("/modules/mailbox/state/nonce?rollup_height={rollup_height}")
            }
        };

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let response = response
            .data
            .and_then(|data| data.value)
            .unwrap_or_default();

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

        // /modules/mailbox/state/deliveries/items/{key}
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
    pub async fn recipient_ism(&self, recipient_id: H256) -> ChainResult<H256> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            address: Option<String>,
        }

        let recipient_bech32 = to_bech32(recipient_id)?;

        let query = format!("/modules/mailbox-recipient-registry/{recipient_bech32}/ism");

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let addr_bech32 = response.data.and_then(|d| d.address).ok_or_else(|| {
            ChainCommunicationError::CustomError(String::from("Data contained None"))
        })?;
        from_bech32(&addr_bech32)
    }

    // @Mailbox - test working
    pub async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        #[derive(Clone, Debug, Deserialize)]
        struct TxData {
            _id: Option<String>,
            status: Option<String>,
        }

        #[derive(Clone, Debug, Deserialize)]
        struct BatchData {
            _blob_hash: Option<String>,
            _da_transaction_id: Option<Vec<u8>>,
            _tx_hashes: Option<Vec<String>>,
        }

        // /sequencer/txs
        let query = "/sequencer/txs";

        let body =
            utils::get_submit_body_string(message, metadata, &self.universal_wallet_client).await?;
        let json = json!({"body":body});
        let response = self
            .http_post(query, &json)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Error: {e}")))?;
        let response: Schema<TxData> = serde_json::from_slice(&response)?;

        let result = match response.data.and_then(|d| d.status) {
            Some(s) => s == *"submitted",
            None => false,
        };

        // /sequencer/batches
        let query = "/sequencer/batches";

        let json = json!(
            {
                "transactions":[body]
            }
        );
        let response = self
            .http_post(query, &json)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Error: {e}")))?;

        let _response: Schema<BatchData> = serde_json::from_slice(&response)?;

        let res = TxOutcome {
            transaction_id: H512::default(),
            executed: result,
            gas_used: U256::default(),
            gas_price: FixedPointNumber::default(),
        };

        Ok(res)
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
            gas_price: Option<Vec<u32>>,
            _priority_fee: Option<u32>,
            _remaining_funds: Option<u32>,
        }

        // /rollup/simulate
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

    // @Mailbox
    pub fn _process_calldata(&self) -> Vec<u8> {
        todo!("Not yet implemented")
    }

    // @ISM
    pub async fn dry_run(&self) -> ChainResult<Option<U256>> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            _data: Option<Value>,
        }

        // /rollup/simulate
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
    pub async fn module_type(&self, ism_id: H256) -> ChainResult<ModuleType> {
        let query = format!(
            "/modules/mailbox-ism-registry/{}/module_type/",
            to_bech32(ism_id)?
        );

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<u32> = serde_json::from_slice(&response)?;

        match response.data.ok_or_else(|| {
            ChainCommunicationError::CustomError(String::from("Data contained None"))
        })? {
            0 => Ok(ModuleType::Unused),
            1 => Ok(ModuleType::Routing),
            2 => Ok(ModuleType::Aggregation),
            3 => Ok(ModuleType::LegacyMultisig),
            4 => Ok(ModuleType::MerkleRootMultisig),
            5 => Ok(ModuleType::MessageIdMultisig),
            6 => Ok(ModuleType::Null),
            7 => Ok(ModuleType::CcipRead),
            _ => Err(ChainCommunicationError::CustomError(String::from(
                "Unknown ModuleType returned",
            ))),
        }
    }

    // @Merkle Tree Hook
    pub async fn tree(&self, hook_id: &str, slot: Option<u32>) -> ChainResult<IncrementalMerkle> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            count: Option<usize>,
            branch: Option<Vec<String>>,
        }

        // /mailbox-hook-merkle-tree/{hook_id}/tree
        let query = match slot {
            Some(0) | None => {
                format!("modules/mailbox-hook-merkle-tree/{hook_id}/tree")
            }
            Some(lag) => {
                let rollup_height = self.get_compensated_rollup_height(u64::from(lag)).await?;
                format!(
                    "modules/mailbox-hook-merkle-tree/{hook_id}/tree?rollup_height={rollup_height}"
                )
            }
        };

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let mut incremental_merkle = IncrementalMerkle {
            count: response.clone().data.and_then(|d| d.count).ok_or_else(|| {
                ChainCommunicationError::ParseError {
                    msg: String::from("Empty field"),
                }
            })?,
            ..Default::default()
        };
        response
            .data
            .and_then(|d| d.branch)
            .ok_or_else(|| {
                ChainCommunicationError::CustomError(String::from("Data contained None"))
            })?
            .into_iter()
            .enumerate()
            .for_each(|(i, f)| incremental_merkle.branch[i] = H256::from_str(&f).unwrap());

        Ok(incremental_merkle)
    }

    // @Merkle Tree Hook
    pub async fn latest_checkpoint(
        &self,
        hook_id: &str,
        lag: Option<u32>,
        mailbox_domain: u32,
    ) -> ChainResult<Checkpoint> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            index: Option<u32>,
            root: Option<String>,
        }

        // /mailbox-hook-merkle-tree/{hook_id}/checkpoint
        let query = match lag {
            Some(0) | None => {
                format!("modules/mailbox-hook-merkle-tree/{hook_id}/checkpoint")
            }
            Some(lag) => {
                let rollup_height = self.get_compensated_rollup_height(u64::from(lag)).await?;
                format!("modules/mailbox-hook-merkle-tree/{hook_id}/checkpoint?rollup_height={rollup_height}")
            }
        };

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let response = Checkpoint {
            merkle_tree_hook_address: from_bech32(hook_id)?,
            mailbox_domain,
            root: H256::from_str(&response.data.clone().and_then(|d| d.root).ok_or_else(
                || ChainCommunicationError::ParseError {
                    msg: String::from("Empty field"),
                },
            )?)?,
            index: response.data.clone().and_then(|d| d.index).ok_or_else(|| {
                ChainCommunicationError::ParseError {
                    msg: String::from("Empty field"),
                }
            })?,
        };

        Ok(response)
    }

    // @MultiSig ISM
    pub async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        #[derive(Clone, Debug, Deserialize)]
        struct Data {
            validators: Option<Vec<String>>,
            threshold: Option<u8>,
        }

        let ism_id = self.recipient_ism(message.recipient).await?;
        let ism_id = to_bech32(ism_id)?;

        let message = hex::encode(RawHyperlaneMessage::from(message));
        let message = format!("0x{message}");

        // /modules/mailbox-ism-registry/{ism_id}/validators_and_threshold
        let query = format!(
            "/modules/mailbox-ism-registry/{ism_id}/validators_and_threshold?data={message}"
        );

        let response = self
            .http_get(&query)
            .await
            .map_err(|e| ChainCommunicationError::CustomError(format!("HTTP Get Error: {e}")))?;
        let response: Schema<Data> = serde_json::from_slice(&response)?;

        let threshold = response.data.clone().and_then(|d| d.threshold).ok_or(
            ChainCommunicationError::CustomError(String::from("Threshold contained None")),
        )?;
        let mut validators: Vec<H256> = Vec::new();
        response
            .data
            .and_then(|d| d.validators)
            .ok_or(ChainCommunicationError::CustomError(String::from(
                "Threshold contained None",
            )))?
            .iter()
            .for_each(|v| {
                let address =
                    H256::from_str(&format!("0x{:0>64}", v.trim_start_matches("0x"))).unwrap();
                validators.push(address);
            });

        let res = (validators, threshold);

        Ok(res)
    }

    // @Routing ISM
    pub fn _route(&self) -> ChainResult<H256> {
        todo!("Not yet implemented")
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

        // /modules/mailbox-va/state/storage-locations/items/{key}
        let mut res = Vec::new();

        for (i, v) in validators.iter().enumerate() {
            res.push(vec![]);
            let validator = try_h256_to_string(*v)?;

            let query = format!("/modules/mailbox-va/state/storage-locations/items/{validator}");

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

        // /modules/mailbox-va/state/storage-locations/items/{key}
        // check if already registered
        let query = format!(
            "/modules/mailbox-va/state/storage-locations/items/{:?}",
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

    // @Validator Announce
    pub fn _announce_tokens_needed(&self) -> Option<U256> {
        todo!("Not yet implemented")
    }
}
