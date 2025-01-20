use std::str::FromStr;

use async_trait::async_trait;
use derive_new::new;
use reqwest::{Client, Response};
use serde_json::{json, Value};
use tokio::time::sleep;
use tonlib_core::TonAddress;
use tracing::{debug, error, info, warn};
use url::Url;

use hyperlane_core::{
    h512_to_bytes, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, FixedPointNumber,
    HyperlaneChain, HyperlaneDomain, HyperlaneProvider, TxOutcome, TxnInfo, TxnReceiptInfo, H256,
    H512, U256,
};

use crate::{
    constants::WORKCHAIN_MASTERCHAIN,
    error::HyperlaneTonError,
    run_get_method::StackItem,
    trait_builder::TonConnectionConf,
    traits::ton_api_center::TonApiCenter,
    types::{
        account_state::AccountStateResponse,
        block_response::BlockResponse,
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
        let hash: H256 = H256::from_slice(&h512_to_bytes(hash));
        info!("Fetching transaction by hash: {:?}", hash);

        let url = self
            .connection_conf
            .url
            .join("v3/transactions")
            .map_err(|e| {
                warn!("Failed to construct transaction URL: {:?}", e);
                ChainCommunicationError::from(HyperlaneTonError::UrlConstructionError(format!(
                    "{:?}",
                    e
                )))
            })?;

        debug!("Constructed transaction URL: {}", url);

        let response = self
            .query_request(url, &[("hash", format!("{:?}", hash))])
            .await
            .map_err(|e| {
                warn!("Error when sending request to TON API");
                ChainCommunicationError::from(HyperlaneTonError::ApiConnectionError(format!(
                    "{:?}",
                    e
                )))
            })?
            .json::<TransactionResponse>()
            .await
            .map_err(|e| {
                warn!("Error deserializing response from TON API");
                ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!("{:?}", e)))
            })?;

        if let Some(transaction) = response.transactions.first() {
            let txn_info = TxnInfo {
                hash: H512::from_slice(&hex::decode(&transaction.hash).unwrap()),
                gas_limit: U256::from_dec_str(&transaction.description.compute_ph.gas_limit)
                    .unwrap_or_default(),
                max_priority_fee_per_gas: None,
                max_fee_per_gas: None,
                gas_price: None,
                nonce: transaction.lt.parse::<u64>().unwrap_or(0),
                sender: H256::from_slice(&hex::decode(&transaction.account).unwrap()),
                recipient: transaction.in_msg.as_ref().and_then(|msg| {
                    match TonAddress::from_base64_url(msg.destination.as_str()) {
                        Ok(ton_address) => Some(ConversionUtils::ton_address_to_h256(&ton_address)),
                        Err(e) => {
                            warn!(
                                "Failed to parse TON address from destination '{}': {:?}",
                                msg.destination, e
                            );
                            None
                        }
                    }
                }),
                receipt: Some(TxnReceiptInfo {
                    gas_used: U256::from_dec_str(&transaction.description.compute_ph.gas_used)
                        .unwrap_or_default(),
                    cumulative_gas_used: U256::zero(),
                    effective_gas_price: None,
                }),
                raw_input_data: None,
            };

            info!("Successfully retrieved transaction: {:?}", txn_info);
            Ok(txn_info)
        } else {
            error!("No transaction found for the provided hash");
            return Err(HyperlaneTonError::TransactionNotFound.into());
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
        info!("Fetching messages with filters");

        let url = self.connection_conf.url.join("v3/messages").map_err(|e| {
            warn!("Failed to construct messages URL: {:?}", e);
            HyperlaneTonError::UrlConstructionError(e.to_string())
        })?;

        debug!("Constructed messages URL: {}", url);

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

        let response = self.query_request(url, &params).await.map_err(|e| {
            warn!("Error sending query request: {:?}", e);
            HyperlaneTonError::ApiRequestFailed(format!("Failed to fetch messages: {:?}", e))
        })?;

        let response_text = response.text().await.map_err(|e| {
            warn!("Error retrieving message response text: {:?}", e);
            HyperlaneTonError::ApiInvalidResponse(format!(
                "Failed to retrieve response text: {:?}",
                e
            ))
        })?;
        debug!("Received response text: {:?}", response_text);

        let parsed_response: MessageResponse =
            serde_json::from_str(&response_text).map_err(|e| {
                warn!("Error parsing message response: {:?}", e);
                HyperlaneTonError::ParsingError(format!(
                    "Failed to parse message response: {:?}",
                    e
                ))
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
        info!("Fetching transactions with filters");

        let url = self
            .connection_conf
            .url
            .join("v3/transactions")
            .map_err(|e| {
                warn!("Failed to construct transactions URL: {:?}", e);
                HyperlaneTonError::UrlConstructionError(e.to_string())
            })?;

        debug!("Constructed transactions URL: {}", url);

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

        let response = self
            .query_request(url, &query_params)
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to fetch transactions: {:?}",
                    e
                ))
            })?
            .json::<TransactionResponse>()
            .await
            .map_err(|e| {
                HyperlaneTonError::ParsingError(format!(
                    "Failed to parse transaction response: {:?}",
                    e
                ))
            })?;

        info!("Successfully retrieved transaction response");
        Ok(response)
    }

    async fn get_account_state(
        &self,
        address: String,
        include_boc: bool,
    ) -> ChainResult<AccountStateResponse> {
        info!(
            "Fetching account state for address: {:?}, include_boc: {:?}",
            address, include_boc
        );

        let url = self
            .connection_conf
            .url
            .join("v3/accountStates")
            .map_err(|e| {
                warn!("Failed to construct account state URL: {:?}", e);
                HyperlaneTonError::UrlConstructionError(e.to_string())
            })?;

        let query_params: Vec<(&str, String)> = vec![
            ("address", address),
            ("include_boc", include_boc.to_string()),
        ];

        let response = self
            .query_request(url, &query_params)
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to send query request: {:?}",
                    e
                ))
            })?
            .json::<AccountStateResponse>()
            .await
            .map_err(|e| {
                HyperlaneTonError::ParsingError(format!(
                    "Failed to parse AccountStateResponse: {:?}",
                    e
                ))
            })?;

        info!("Successfully retrieved account state response");
        Ok(response)
    }

    async fn get_wallet_information(
        &self,
        address: &str,
        use_v2: bool,
    ) -> ChainResult<WalletInformation> {
        info!("get_wallet_information executed");
        let url = self
            .connection_conf
            .url
            .join("v3/walletInformation")
            .map_err(|e| {
                warn!("Failed to construct account state URL: {:?}", e);
                HyperlaneTonError::UrlConstructionError(e.to_string())
            })?;

        let query_params: Vec<(&str, String)> = vec![
            ("address", address.to_string()),
            ("use_v2", use_v2.to_string()),
        ];

        let response = self
            .query_request(url, &query_params)
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to send query request: {:?}",
                    e
                ))
            })?
            .json::<WalletInformation>()
            .await
            .map_err(|e| {
                HyperlaneTonError::ParsingError(format!(
                    "Failed to parse WalletInformation: {:?}",
                    e
                ))
            })?;
        info!("response:{:?}", response);
        Ok(response)
    }

    async fn run_get_method(
        &self,
        address: String,
        method: String,
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
        let url = self
            .connection_conf
            .url
            .join("v3/walletStates")
            .map_err(|e| {
                warn!("Failed to construct wallet states URL: {:?}", e);
                HyperlaneTonError::UrlConstructionError(e.to_string())
            })?;

        let query_params = [("address", account)];
        debug!("Constructed wallet states URL: {:?}", url);

        let response = self.query_request(url, &query_params).await.map_err(|e| {
            warn!("Failed to send wallet states request: {:?}", e);
            HyperlaneTonError::ApiRequestFailed(format!(
                "Failed to send wallet states request: {:?}",
                e
            ))
        })?;

        let body = response.text().await.map_err(|e| {
            warn!("Failed to retrieve response body: {:?}", e);
            HyperlaneTonError::ApiInvalidResponse(format!(
                "Failed to retrieve response body: {:?}",
                e
            ))
        })?;

        let result: WalletStatesResponse = serde_json::from_str(&body).map_err(|e| {
            HyperlaneTonError::ParsingError(format!(
                "Failed to parse wallet states response: {:?}",
                e
            ))
        })?;

        info!("Successfully retrieved wallet states");
        Ok(result)
    }

    async fn get_transaction_by_message(
        &self,
        msg_hash: String,
        body_hash: Option<String>,
        opcode: Option<String>,
    ) -> ChainResult<TransactionResponse> {
        info!("Fetching transactions by message");

        let url = self
            .connection_conf
            .url
            .join("v3/transactionsByMessage")
            .map_err(|e| {
                warn!("Failed to construct transactions URL: {:?}", e);
                HyperlaneTonError::UrlConstructionError(e.to_string())
            })?;

        debug!("Constructed transactions URL: {}", url);

        let query_params: Vec<(&str, String)> = vec![
            ("msg_hash", msg_hash),
            ("body_hash", body_hash.unwrap_or_default()),
            ("opcode", opcode.unwrap_or_default()),
        ]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect();

        let raw_response = self
            .query_request(url, &query_params)
            .await
            .map_err(|e| {
                warn!("Failed to send transactionsByMessage request: {:?}", e);
                HyperlaneTonError::ApiRequestFailed(format!("Error: {:?}", e))
            })?
            .text()
            .await
            .map_err(|e| {
                warn!("Failed to read transactionsByMessage response: {:?}", e);
                HyperlaneTonError::ApiInvalidResponse(format!("Error: {:?}", e))
            })?;

        let response: TransactionResponse = serde_json::from_str(&raw_response).map_err(|e| {
            warn!("Failed to parse transactionsByMessage response: {:?}", e);
            HyperlaneTonError::ParsingError(format!("Failed to parse response JSON: {:?}", e))
        })?;

        info!("Successfully retrieved transaction response");
        Ok(response)
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
        let url = self.connection_conf.url.join("v3/blocks").map_err(|e| {
            warn!("Failed to construct transactions URL: {:?}", e);
            HyperlaneTonError::UrlConstructionError(e.to_string())
        })?;

        info!("Constructed transactions URL: {}", url);

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
        let raw_response = self
            .query_request(url, &query_params)
            .await
            .map_err(|e| {
                warn!("Error sending request to fetch blocks: {:?}", e);
                HyperlaneTonError::ApiRequestFailed(format!("Error: {:?}", e))
            })?
            .text()
            .await
            .map_err(|e| {
                warn!("Error reading response text while fetching blocks: {:?}", e);
                HyperlaneTonError::ApiInvalidResponse(format!("Error: {:?}", e))
            })?;

        info!("Raw response from server: {}", raw_response);

        let response: BlockResponse = serde_json::from_str(&raw_response)?;

        info!("Successfully retrieved blocks response");
        Ok(response)
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
