use std::ops::RangeInclusive;
use std::{cmp::max, str::FromStr};

use async_trait::async_trait;
use derive_new::new;
use reqwest::{Client, Method, Response};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::time::sleep;
use tracing::{error, info, warn};
use url::Url;

use hyperlane_core::{
    h512_to_bytes, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, FixedPointNumber,
    HyperlaneChain, HyperlaneDomain, HyperlaneProvider, TxOutcome, TxnInfo, H256, H512, U256,
};

use crate::constants::{
    ACCOUNT_STATES_ENDPOINT, BLOCKS_ENDPOINT, JETTON_WALLETS_ENDPOINT, MESSAGES_ENDPOINT,
    TRANSACTIONS_BY_MESSAGE_ENDPOINT, TRANSACTIONS_ENDPOINT, WALLET_INFORMATION_ENDPOINT,
    WALLET_STATE_ENDPOINT, WORKCHAIN_MASTERCHAIN,
};
use crate::{
    error::HyperlaneTonError,
    run_get_method::StackItem,
    trait_builder::TonConnectionConf,
    traits::ton_api_center::TonApiCenter,
    types::{
        account_state::AccountStateResponse,
        block_response::BlockResponse,
        jetton_wallet_response::GetJettonWalletsResponse,
        message::{MessageResponse, SendMessageResponse},
        run_get_method::RunGetMethodResponse,
        transaction::TransactionResponse,
        wallet_state::{WalletInformation, WalletStatesResponse},
    },
    utils::conversion::ConversionUtils,
};

#[derive(Clone, new)]
pub struct TonProvider {
    pub http_client: Client,
    pub connection_conf: TonConnectionConf,
    pub domain: HyperlaneDomain,
}

impl TonProvider {
    pub async fn request_and_parse<T: DeserializeOwned>(
        &self,
        method: Method,
        endpoint: &str,
        params: Option<&[(&str, String)]>,
        body: Option<&Value>,
    ) -> ChainResult<T> {
        let url = self
            .connection_conf
            .url
            .join(endpoint)
            .map_err(|e| HyperlaneTonError::UrlConstructionError(e.to_string()))?;

        let response: Response = match method {
            Method::GET => self
                .query_request(url, params.unwrap_or(&[]))
                .await
                .map_err(|e| {
                    HyperlaneTonError::ApiRequestFailed(format!("Request error: {:?}", e))
                })?,
            Method::POST => self.post_request(url, body.unwrap_or(&json!({}))).await?,
            _ => panic!("Not supported http method"),
        };

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(HyperlaneTonError::ApiInvalidResponse(format!(
                "Request failed with status: {}, body: {}",
                status, body
            ))
            .into());
        }

        let response_text = response.text().await.map_err(|e| {
            HyperlaneTonError::ApiInvalidResponse(format!("Failed to get response text: {:?}", e))
        })?;

        let parsed: T = serde_json::from_str(&response_text).map_err(|e| {
            HyperlaneTonError::ParsingError(format!("Failed to parse JSON: {:?}", e))
        })?;

        Ok(parsed)
    }
    async fn post_request(
        &self,
        url: Url,
        params: &Value,
    ) -> Result<Response, ChainCommunicationError> {
        let result = self
            .http_client
            .post(url)
            .header("accept", "application/json")
            .header("Content-Type", "application/json")
            .header("X-API-Key", self.connection_conf.api_key.clone())
            .json(params)
            .send()
            .await
            .map_err(|e| {
                error!("Error sending request: {:?}", e);
                HyperlaneTonError::ApiConnectionError(format!("{:?}", e)).into()
            });
        result
    }

    async fn query_request<T: serde::Serialize + ?Sized>(
        &self,
        url: Url,
        params: &T,
    ) -> Result<Response, reqwest::Error> {
        self.http_client
            .get(url)
            .query(params)
            .header("accept", "application/json")
            .header("Content-Type", "application/json")
            .header("X-API-Key", self.connection_conf.api_key.clone())
            .send()
            .await
    }
}
impl std::fmt::Debug for TonProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TonProvider")
            .field("client", &self.http_client)
            .field("domain", &self.domain)
            .finish()
    }
}
impl HyperlaneChain for TonProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for TonProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let response = self
            .get_blocks(
                WORKCHAIN_MASTERCHAIN,
                None,
                Some(height),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .map_err(|e| {
                error!("Error fetching block by height {}: {:?}", height, e);
                ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(format!(
                    "Failed to get block by height {}: {:?}",
                    height, e
                )))
            })?;

        let block = response.blocks.first().ok_or_else(|| {
            warn!("No blocks found in the response: {:?}", response);
            HyperlaneTonError::NoBlocksFound
        })?;

        let timestamp = block.gen_utime.parse::<u64>().map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse block timestamp: {:?}",
                e
            )))
        })?;

        let hash = ConversionUtils::base64_to_h256(block.root_hash.as_str()).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse hash timestamp: {:?}",
                e
            )))
        })?;

        Ok(BlockInfo {
            hash,
            timestamp,
            number: block.seqno as u64,
        })
    }

    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let bytes = &h512_to_bytes(hash);
        let tx_hash = hex::encode(bytes);

        let query_params = vec![("hash", tx_hash.clone())];
        let response: TransactionResponse = self
            .request_and_parse(
                Method::GET,
                TRANSACTIONS_ENDPOINT,
                Some(&query_params),
                None,
            )
            .await
            .map_err(|e| {
                warn!("Error fetching transaction by hash: {:?}", e);
                HyperlaneTonError::ApiConnectionError(format!("{:?}", e))
            })?;

        if let Some(transaction) = response.transactions.first() {
            let txn_info = ConversionUtils::parse_transaction(transaction)?;
            info!("Successfully retrieved transaction: {:?}", txn_info);
            Ok(txn_info)
        } else {
            error!("No transaction found for the provided hash");
            Err(HyperlaneTonError::TransactionNotFound.into())
        }
    }

    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        info!("Checking if contract exists at address: {:?}", address);
        let ton_address = ConversionUtils::h256_to_ton_address(address, 0).to_string();

        let account_state = self
            .get_account_state(ton_address.to_string(), true)
            .await
            .map_err(|e| {
                warn!(
                    "Failed to get account state for address {:?}: {:?}",
                    ton_address, e
                );
                ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(format!(
                    "Failed to get account state for address {:?}: {:?}",
                    ton_address, e
                )))
            })?;

        let account = account_state.accounts.first().ok_or_else(|| {
            warn!(
                "No account found for the address: {:?}. Assuming it is not a contract.",
                ton_address
            );
            HyperlaneTonError::AccountNotFound(ton_address.clone())
        })?;

        if account.code_boc.is_some() {
            info!("Address {:?} is a contract.", ton_address);
            Ok(true)
        } else {
            info!("Address {:?} is not a contract.", ton_address);
            Ok(false)
        }
    }
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        info!("Fetching balance for address: {:?}", address);

        let account_state = self
            .get_account_state(address.clone(), false)
            .await
            .map_err(|e| {
                warn!(
                    "Error while getting account state for {:?}: {:?}",
                    address, e
                );
                HyperlaneTonError::ApiInvalidResponse(format!(
                    "Failed to get account state for address {:?}: {:?}",
                    address, e
                ))
            })?;

        let first_account = account_state.accounts.first().ok_or_else(|| {
            warn!(
                "No account found in the response for address: {:?}",
                address
            );
            HyperlaneTonError::AccountNotFound(address.clone())
        })?;

        let balance =
            U256::from_dec_str(first_account.balance.as_deref().ok_or_else(|| {
                HyperlaneTonError::ParsingError("Balance is missing".to_string())
            })?)
            .map_err(|e| {
                warn!("Failed to parse balance for address {:?}: {:?}", address, e);
                HyperlaneTonError::ParsingError(format!(
                    "Failed to parse balance for address {:?}: {:?}",
                    address, e
                ))
            })?;

        info!("Successfully retrieved balance: {:?}", balance);
        Ok(balance)
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}

#[async_trait]
impl TonApiCenter for TonProvider {
    /// Implements a method to retrieve messages from the TON network based on specified filters.
    /// Parameters include message hashes, source and destination addresses,
    /// and time or other filters for querying messages.
    /// Returns the results in a `MessageResponse` format.
    async fn get_messages(
        &self,
        msg_hash: Option<Vec<String>>,
        body_hash: Option<String>,
        source: Option<String>,
        destination: Option<String>,
        opcode: Option<String>,
        start_utime: Option<i64>,
        end_utime: Option<i64>,
        start_lt: Option<i64>,
        end_lt: Option<i64>,
        direction: Option<String>,
        limit: Option<u32>,
        offset: Option<u32>,
        sort: Option<String>,
    ) -> ChainResult<MessageResponse> {
        let params: Vec<(&str, String)> = vec![
            ("msg_hash", msg_hash.map(|v| v.join(","))),
            ("body_hash", body_hash),
            ("source", source),
            ("destination", destination),
            ("opcode", opcode),
            ("start_utime", start_utime.map(|v| v.to_string())),
            ("end_utime", end_utime.map(|v| v.to_string())),
            ("start_lt", start_lt.map(|v| v.to_string())),
            ("end_lt", end_lt.map(|v| v.to_string())),
            ("direction", direction),
            ("limit", limit.map(|v| v.to_string())),
            ("offset", offset.map(|v| v.to_string())),
            ("sort", sort),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.map(|v| (key, v)))
        .collect();

        info!("Constructed query parameters for messages: {:?}", params);

        let parsed_response: MessageResponse = self
            .request_and_parse(Method::GET, MESSAGES_ENDPOINT, Some(&params), None)
            .await
            .map_err(|e| {
                warn!("Failed to fetch messages: {:?}", e);
                e
            })?;

        info!("Successfully parsed message response");
        Ok(parsed_response)
    }
    async fn get_transactions(
        &self,
        workchain: Option<i32>,
        shard: Option<String>,
        seqno: Option<i32>,
        mc_seqno: Option<i32>,
        account: Option<Vec<String>>,
        exclude_account: Option<Vec<String>>,
        hash: Option<String>,
        lt: Option<i64>,
        start_utime: Option<i64>,
        end_utime: Option<i64>,
        start_lt: Option<i64>,
        end_lt: Option<i64>,
        limit: Option<u32>,
        offset: Option<u32>,
        sort: Option<String>,
    ) -> ChainResult<TransactionResponse> {
        let query_params: Vec<(&str, String)> = vec![
            ("workchain", workchain.map(|v| v.to_string())),
            ("shard", shard),
            ("seqno", seqno.map(|v| v.to_string())),
            ("mc_seqno", mc_seqno.map(|v| v.to_string())),
            ("account", account.map(|v| v.join(","))),
            ("exclude_account", exclude_account.map(|v| v.join(","))),
            ("hash", hash),
            ("lt", lt.map(|v| v.to_string())),
            ("start_utime", start_utime.map(|v| v.to_string())),
            ("end_utime", end_utime.map(|v| v.to_string())),
            ("start_lt", start_lt.map(|v| v.to_string())),
            ("end_lt", end_lt.map(|v| v.to_string())),
            ("limit", limit.map(|v| v.to_string())),
            ("offset", offset.map(|v| v.to_string())),
            ("sort", sort),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.map(|v| (key, v)))
        .collect();

        let parsed_response: TransactionResponse = self
            .request_and_parse(
                Method::GET,
                TRANSACTIONS_ENDPOINT,
                Some(&query_params),
                None,
            )
            .await
            .map_err(|e| {
                warn!("Failed to fetch messages: {:?}", e);
                e
            })?;
        Ok(parsed_response)
    }

    async fn get_account_state(
        &self,
        address: String,
        include_boc: bool,
    ) -> ChainResult<AccountStateResponse> {
        let query_params: Vec<(&str, String)> = vec![
            ("address", address),
            ("include_boc", include_boc.to_string()),
        ];

        let response: AccountStateResponse = self
            .request_and_parse(
                Method::GET,
                ACCOUNT_STATES_ENDPOINT,
                Some(&query_params),
                None,
            )
            .await
            .map_err(|e| {
                warn!("Failed to fetch account state: {:?}", e);
                e
            })?;
        Ok(response)
    }

    async fn get_wallet_information(
        &self,
        address: &str,
        use_v2: bool,
    ) -> ChainResult<WalletInformation> {
        let query_params: Vec<(&str, String)> = vec![
            ("address", address.to_string()),
            ("use_v2", use_v2.to_string()),
        ];

        let parsed_response: WalletInformation = self
            .request_and_parse(
                Method::GET,
                WALLET_INFORMATION_ENDPOINT,
                Some(&query_params),
                None,
            )
            .await
            .map_err(|e| {
                warn!("Failed to fetch wallet information: {:?}", e);
                e
            })?;
        Ok(parsed_response)
    }

    async fn run_get_method(
        &self,
        address: &str,
        method: &str,
        stack: Option<Vec<StackItem>>,
    ) -> ChainResult<RunGetMethodResponse> {
        info!(
            "Calling get method for address: {:?}, method: {:?}, stack: {:?}",
            address, method, stack
        );

        let url = self
            .connection_conf
            .url
            .join("v3/runGetMethod")
            .map_err(|e| {
                warn!("Failed to construct account state URL: {:?}", e);
                HyperlaneTonError::UrlConstructionError(e.to_string())
            })?;

        let stack_data = stack.unwrap_or_else(|| vec![]);

        let params = json!({
            "address": address,
            "method": method,
            "stack": stack_data
        });
        info!(
            "Constructed runGetMethod request body: {:?}",
            params.to_string()
        );

        let response = self
            .post_request(url, &params)
            .await
            .map_err(|e| {
                info!("Error sending runGetMethod request: {:?}", e);
                HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to execute run_get_method: {:?}",
                    e
                ))
            })
            .unwrap();

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to get response body".to_string());
            warn!("Request failed with status: {}, body: {:?}", status, body);
            return Err(ChainCommunicationError::from(
                HyperlaneTonError::ApiInvalidResponse(format!(
                    "Request failed with status: {}, body: {:?}",
                    status, body
                )),
            ));
        }
        let response_text = response.text().await.map_err(|e| {
            warn!("Failed to retrieve response text: {:?}", e);
            HyperlaneTonError::ApiInvalidResponse(format!(
                "Failed to retrieve response text: {:?}",
                e
            ))
        })?;
        info!("Received response text: {:?}", response_text);

        let parsed_response = serde_json::from_str::<RunGetMethodResponse>(&response_text)
            .map_err(|e| {
                warn!("Failed to parse run_get_method response: {:?}", e);
                HyperlaneTonError::ParsingError(format!("Failed to parse response: {:?}", e))
            })?;

        info!(
            "Successfully executed run_get_method request:{:?}",
            parsed_response
        );
        Ok(parsed_response)
    }

    async fn send_message(&self, boc: String) -> ChainResult<SendMessageResponse> {
        let url = self.connection_conf.url.join("v3/message").map_err(|e| {
            warn!("Failed to construct message URL: {:?}", e);
            HyperlaneTonError::UrlConstructionError(e.to_string())
        })?;

        let params = json!({
            "boc": boc
        });

        let response = self.post_request(url, &params).await.map_err(|e| {
            warn!("Failed to send message request: {:?}", e);
            ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                "Failed to send message: {}",
                e
            )))
        })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read response body".to_string());
            warn!("Request failed with status: {}, body: {}", status, body);

            return Err(HyperlaneTonError::ApiInvalidResponse(format!(
                "Request failed with status: {}, body: {}",
                status, body
            ))
            .into());
        }
        let send_message_response: SendMessageResponse = response.json().await.map_err(|e| {
            warn!("Error parsing send_message response: {:?}", e);
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse response JSON: {}",
                e
            )))
        })?;

        Ok(send_message_response)
    }

    async fn get_wallet_states(&self, mut account: String) -> ChainResult<WalletStatesResponse> {
        if account.starts_with("0x") {
            let h256 = H256::from_str(&account[2..]).map_err(|e| {
                warn!("Failed to parse H256 address: {:?}", e);
                HyperlaneTonError::ParsingError(format!("Failed to parse H256 address: {:?}", e))
            })?;

            account = ConversionUtils::h256_to_ton_address(&h256, 0).to_string();
        }

        let query_params = [("address", account)];

        let result = self
            .request_and_parse(
                Method::GET,
                WALLET_STATE_ENDPOINT,
                Some(&query_params),
                None,
            )
            .await
            .map_err(|e| {
                warn!("Failed to fetch wallet states: {:?}", e);
                e
            })?;
        Ok(result)
    }

    async fn get_transaction_by_message(
        &self,
        msg_hash: String,
        body_hash: Option<String>,
        opcode: Option<String>,
    ) -> ChainResult<TransactionResponse> {
        let query_params: Vec<(&str, String)> = vec![
            ("msg_hash", msg_hash),
            ("body_hash", body_hash.unwrap_or_default()),
            ("opcode", opcode.unwrap_or_default()),
        ]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect();

        let parsed_response: TransactionResponse = self
            .request_and_parse(
                Method::GET,
                TRANSACTIONS_BY_MESSAGE_ENDPOINT,
                Some(&query_params),
                None,
            )
            .await
            .map_err(|e| {
                warn!("Failed to fetch transaction by message: {:?}", e);
                e
            })?;
        Ok(parsed_response)
    }

    async fn get_blocks(
        &self,
        workchain: i32,
        shard: Option<String>,
        seqno: Option<u64>,
        mc_seqno: Option<u32>,
        start_utime: Option<i64>,
        end_utime: Option<i64>,
        start_lt: Option<i64>,
        end_lt: Option<i64>,
        limit: Option<u32>,
        offset: Option<u32>,
        sort: Option<String>,
    ) -> ChainResult<BlockResponse> {
        let query_params: Vec<(&str, String)> = vec![
            ("workchain", workchain.to_string()),
            ("shard", shard.unwrap_or_default()),
            ("seqno", seqno.map_or("".to_string(), |s| s.to_string())),
            (
                "mc_seqno",
                mc_seqno.map_or("".to_string(), |s| s.to_string()),
            ),
            (
                "start_utime",
                start_utime.map_or("".to_string(), |s| s.to_string()),
            ),
            (
                "end_utime",
                end_utime.map_or("".to_string(), |s| s.to_string()),
            ),
            (
                "start_lt",
                start_lt.map_or("".to_string(), |s| s.to_string()),
            ),
            ("end_lt", end_lt.map_or("".to_string(), |s| s.to_string())),
            ("limit", limit.map_or("10".to_string(), |l| l.to_string())),
            ("offset", offset.map_or("0".to_string(), |o| o.to_string())),
            ("sort", sort.unwrap_or("desc".to_string())),
        ]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect();

        info!("Query params:{:?}", query_params);

        let parsed_response: BlockResponse = self
            .request_and_parse(Method::GET, BLOCKS_ENDPOINT, Some(&query_params), None)
            .await
            .map_err(|e| {
                warn!("Failed to get blocks: {:?}", e);
                e
            })?;
        Ok(parsed_response)
    }
}

impl TonProvider {
    pub async fn wait_for_transaction(&self, message_hash: String) -> ChainResult<TxOutcome> {
        let max_attempts = self.connection_conf.max_attempts;
        let delay = self.connection_conf.timeout;

        for attempt in 1..=max_attempts {
            info!("Attempt {}/{}", attempt, max_attempts);

            match self
                .get_transaction_by_message(message_hash.clone(), None, None)
                .await
            {
                Ok(response) => {
                    if response.transactions.is_empty() {
                        info!("Transaction not found, retrying...");
                    } else {
                        info!(
                            "Transaction found: {:?}",
                            response
                                .transactions
                                .first()
                                .expect("Failed to get first transaction from list")
                        );

                        if let Some(transaction) = response.transactions.first() {
                            let transaction_id = ConversionUtils::base64_to_h512(&transaction.hash)
                                .map_err(|e| {
                                    HyperlaneTonError::ParsingError(format!(
                                        "Failed to convert hash to H512: {:?}",
                                        e
                                    ))
                                })?;

                            let tx_outcome = TxOutcome {
                                transaction_id,
                                executed: !transaction.description.aborted,
                                gas_used: U256::from_dec_str(
                                    &transaction.description.compute_ph.gas_used,
                                )
                                .unwrap_or_else(|_| {
                                    warn!("Failed to parse gas used; defaulting to 0.");
                                    U256::zero()
                                }),
                                gas_price: FixedPointNumber::from(0),
                            };

                            info!("Tx outcome: {:?}", tx_outcome);
                            return Ok(tx_outcome);
                        }
                    }
                }
                Err(e) => {
                    info!("Transaction not found, retrying... {:?}", e);
                    if attempt == max_attempts {
                        return Err(HyperlaneTonError::TransactionNotFound.into());
                    }
                }
            }

            sleep(delay).await;
        }

        Err(HyperlaneTonError::Timeout.into())
    }

    pub async fn fetch_block_timestamp(&self, block_seqno: u32) -> ChainResult<i64> {
        let response = self
            .get_blocks(
                WORKCHAIN_MASTERCHAIN,
                None,
                None,
                Some(block_seqno),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiInvalidResponse(format!(
                    "Failed to fetch block info for block {}: {:?}",
                    block_seqno, e
                ))
            })?;

        let block_info = response
            .blocks
            .get(0)
            .ok_or_else(|| HyperlaneTonError::NoBlocksFound)?;

        block_info.gen_utime.parse::<i64>().map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse block timestamp: {:?}",
                e
            )))
        })
    }
    pub async fn get_finalized_block(&self) -> ChainResult<u32> {
        let response = self
            .get_blocks(
                WORKCHAIN_MASTERCHAIN, // masterchain
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(1), // Limit: 1
                None,
                None,
            )
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to fetch latest block: {:?}",
                    e
                ))
            })?;

        let block = response
            .blocks
            .first()
            .ok_or(HyperlaneTonError::NoBlocksFound)?;

        info!("Latest block found: {:?}", block.seqno);
        Ok(block.seqno as u32)
    }

    pub async fn get_logs(
        &self,
        address: &str,
        start_utime: i64,
        end_utime: i64,
        limit: u32,
        offset: u32,
    ) -> ChainResult<MessageResponse> {
        self.get_messages(
            None,                      // msg_hash
            None,                      // body_hash
            Some(address.to_string()), // source
            None,                      // destination
            None,                      // opcode
            Some(start_utime),         // start_utime
            Some(end_utime),           // end_utime
            None,                      // start_lt
            None,                      // end_lt
            None,                      // direction
            Some(limit),               // limit
            Some(offset),              // offset
            Some("desc".to_string()),  // sort
        )
        .await
    }

    pub async fn get_utime_range(&self, range: RangeInclusive<u32>) -> ChainResult<(i64, i64)> {
        let start_block = max(*range.start(), 1);
        let end_block = max(*range.end(), 1);

        let timestamps = self
            .fetch_blocks_timestamps(vec![start_block, end_block])
            .await?;

        let start_utime = *timestamps.get(0).ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                "Failed to get start_utime".to_string(),
            ))
        })?;
        let end_utime = *timestamps.get(1).ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                "Failed to get end_utime".to_string(),
            ))
        })?;
        Ok((start_utime, end_utime))
    }

    pub async fn fetch_blocks_timestamps(&self, blocks: Vec<u32>) -> ChainResult<Vec<i64>> {
        let mut timestamps = Vec::new();

        for block in blocks {
            let response = self
                .get_blocks(
                    WORKCHAIN_MASTERCHAIN, // masterchain
                    None,
                    None,
                    Some(block), // masterchain seqno
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await
                .map_err(|e| {
                    HyperlaneTonError::ApiInvalidResponse(format!(
                        "Failed to fetch block {}: {:?}",
                        block, e
                    ))
                })?;

            let block_info = response
                .blocks
                .get(0)
                .ok_or_else(|| HyperlaneTonError::NoBlocksFound)?;

            let timestamp = block_info.gen_utime.parse::<i64>().map_err(|e| {
                HyperlaneTonError::ParsingError(format!(
                    "Failed to parse block timestamp for block {}: {:?}",
                    block, e
                ))
            })?;

            timestamps.push(timestamp);
        }

        Ok(timestamps)
    }
}

use crate::ton_api_center::TonApiCenterTestUtils;
#[cfg(feature = "test-utils")]
#[async_trait]
impl TonApiCenterTestUtils for TonProvider {
    async fn get_jetton_wallets(
        &self,
        address: Option<Vec<String>>,
        owner_address: Option<Vec<String>>,
        jetton_address: Option<Vec<String>>,
        exclude_zero_balance: Option<bool>,
        limit: Option<u32>,
        offset: Option<u32>,
        sort: Option<String>,
    ) -> ChainResult<GetJettonWalletsResponse> {
        let query_params: Vec<(&str, String)> = vec![
            ("address", address.map(|v| v.join(","))),
            ("owner_address", owner_address.map(|v| v.join(","))),
            ("jetton_address", jetton_address.map(|v| v.join(","))),
            (
                "exclude_zero_balance",
                exclude_zero_balance.map(|v| v.to_string()),
            ),
            ("limit", limit.map(|v| v.to_string())),
            ("offset", offset.map(|v| v.to_string())),
            ("sort", sort),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.map(|v| (key, v)))
        .collect();

        info!(
            "Constructed query parameters for jetton wallets: {:?}",
            query_params
        );

        let parsed_response: GetJettonWalletsResponse = self
            .request_and_parse(
                Method::GET,
                JETTON_WALLETS_ENDPOINT,
                Some(&query_params),
                None,
            )
            .await
            .map_err(|e| {
                warn!("Failed to fetch jetton wallets: {:?}", e);
                e
            })?;

        info!("Successfully parsed jetton wallets response");
        Ok(parsed_response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Client;
    use std::env;
    use tokio;
    use tonlib_core::TonAddress;
    use url::Url;

    fn create_test_provider() -> TonProvider {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .try_init();
        let api_key = env::var("API_KEY").expect("API_KEY env variable must be set");

        let client = Client::new();

        let url = Url::from_str("https://testnet.toncenter.com/api/")
            .expect("Failed to create url from str");

        let config = TonConnectionConf::new(url, api_key, 10);

        let provider = TonProvider::new(
            client,
            config,
            HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::TonTest1),
        );
        provider
    }

    fn h256_to_h512(h: H256) -> H512 {
        let mut bytes = [0u8; 64];
        bytes[32..].copy_from_slice(h.as_bytes());
        H512::from_slice(&bytes)
    }

    #[tokio::test]
    #[ignore]
    async fn test_get_block_by_height() {
        let provider = create_test_provider();
        let block_result = provider.get_block_by_height(1).await;
        assert!(
            block_result.is_ok(),
            "Expected get_block_by_height to succeed, got error: {:?}",
            block_result
        );

        let block_info = block_result.unwrap();
        info!("Block info for height 1: {:?}", block_info);

        assert_eq!(block_info.number, 1, "Block number should be 1");
    }
    #[tokio::test]
    #[ignore]
    async fn test_get_block_by_height_max_number() {
        let provider = create_test_provider();
        let block_result = provider.get_block_by_height(u64::MAX).await;
        assert!(
            block_result.is_err(),
            "Expected get_block_by_height to fail with an error, but got success: {:?}",
            block_result
        );

        if let Err(e) = block_result {
            println!("Got expected error for u64::MAX block height: {:?}", e);
        }
    }

    #[tokio::test]
    #[ignore]
    /// cargo test test_get_txn_by_hash_real -- --ignored --nocapture
    async fn test_get_txn_by_hash_real() {
        let provider = create_test_provider();
        let txn_hash_str = "c99043c6d1862b57a12fa556e3b0c02e945d0e784b6923cdb9aeb32bcae4ff08";
        let h256 = H256::from_str(txn_hash_str).expect("Invalid H256 format");
        let hash = h256_to_h512(h256);
        println!("hash:{:?}", hash);

        let result = provider.get_txn_by_hash(&hash).await;
        println!("Result for transaction hash {}: {:?}", txn_hash_str, result);

        assert!(
            result.is_ok(),
            "Expected transaction to be found, got error: {:?}",
            result
        );
        let txn_info = result.unwrap();
        println!("Transaction info: {:?}", txn_info);
    }

    #[tokio::test]
    #[ignore]
    async fn test_is_contract_true() {
        let provider = create_test_provider();

        let contract_address =
            TonAddress::from_base64_url("0QCSES0TZYqcVkgoguhIb8iMEo4cvaEwmIrU5qbQgnN8fo2A")
                .expect("msg");
        let contract_address = ConversionUtils::ton_address_to_h256(&contract_address);

        let result = provider.is_contract(&contract_address).await;
        println!("is_contract({:?}) returned: {:?}", contract_address, result);

        assert!(
            result.is_ok(),
            "Expected is_contract to succeed, got error: {:?}",
            result
        );
        let is_contract = result.unwrap();
        assert!(is_contract, "Expected address to be a contract");
    }
    #[tokio::test]
    #[ignore]
    async fn test_get_balance() {
        let provider = create_test_provider();
        let address = "UQCvsB60DElBwHpHOj26K9NfxGJgzes_5pzwV48QGxHar2F3".to_string();

        let result = provider.get_balance(address.clone()).await;
        println!("Balance result for {}: {:?}", address, result);

        assert!(
            result.is_ok(),
            "Expected balance retrieval to succeed, got error: {:?}",
            result
        );
        let balance = result.unwrap();
        println!("Balance: {:?}", balance);
    }
    #[tokio::test]
    #[ignore]
    async fn test_get_wallet_information() {
        let provider = create_test_provider();
        let address = "0QCvsB60DElBwHpHOj26K9NfxGJgzes_5pzwV48QGxHar9r9";

        let result = provider.get_wallet_information(address, true).await;
        println!("Wallet information result: {:?}", result);

        assert!(
            result.is_ok(),
            "Expected wallet information retrieval to succeed, got error: {:?}",
            result
        );
    }
    #[tokio::test]
    #[ignore]
    async fn test_get_blocks() {
        let provider = create_test_provider();
        let workchain = -1;
        let seqno = Some(1);

        let result = provider
            .get_blocks(
                workchain, None, seqno, None, None, None, None, None, None, None, None,
            )
            .await;

        println!("Block result: {:?}", result);

        assert!(
            result.is_ok(),
            "Expected get_blocks to succeed, got error: {:?}",
            result
        );
    }
    #[tokio::test]
    #[ignore]
    async fn test_get_blocks_invalid_seqno() {
        let provider = create_test_provider();
        let workchain = 0;
        let seqno = Some(u64::MAX);

        let result = provider
            .get_blocks(
                workchain, None, seqno, None, None, None, None, None, None, None, None,
            )
            .await;

        println!("Block result for invalid seqno: {:?}", result);

        assert!(
            result.is_err(),
            "Expected get_blocks to fail for an invalid seqno"
        );
    }
    #[tokio::test]
    #[ignore]
    async fn test_fetch_block_timestamp() {
        let provider = create_test_provider();
        let block_seqno = 1;

        let result = provider.fetch_block_timestamp(block_seqno).await;
        println!("Block timestamp result: {:?}", result);

        assert!(
            result.is_ok(),
            "Expected fetch_block_timestamp to succeed, got error: {:?}",
            result
        );
    }
    #[tokio::test]
    #[ignore]
    async fn test_fetch_block_timestamp_invalid_seqno() {
        let provider = create_test_provider();
        let block_seqno = u32::MAX;

        let result = provider.fetch_block_timestamp(block_seqno).await;
        println!("Block timestamp result for invalid seqno: {:?}", result);

        assert!(
            result.is_err(),
            "Expected fetch_block_timestamp to fail for an invalid block seqno"
        );
    }
    #[tokio::test]
    #[ignore]
    async fn test_get_finalized_block() {
        let provider = create_test_provider();

        let result = provider.get_finalized_block().await;
        println!("Finalized block result: {:?}", result);

        assert!(
            result.is_ok(),
            "Expected get_finalized_block to succeed, got error: {:?}",
            result
        );
    }

    use super::*;
    #[ignore]
    #[cfg(all(test, feature = "test-utils"))]
    #[tokio::test]
    #[ignore]
    async fn test_get_jetton_wallet_info() {
        let provider = create_test_provider();

        let owner_address = Some(vec![
            "0QCvsB60DElBwHpHOj26K9NfxGJgzes_5pzwV48QGxHar9r9".to_string()
        ]);

        let result = provider
            .get_jetton_wallets(None, owner_address, None, None, Some(10), Some(0), None)
            .await;

        match result {
            Ok(response) => {
                println!("Jetton wallet info: {:?}", response.jetton_wallets);
                assert!(
                    !response.jetton_wallets.is_empty(),
                    "Expected some jetton wallets"
                );
            }
            Err(e) => panic!("Error fetching jetton wallet info: {:?}", e),
        }
    }
}
