#![allow(dead_code)]

use async_trait::async_trait;
use hyperlane_core::{ChainCommunicationError, ChainResult};
use reqwest::Client;
use serde::Deserialize;
use solana_sdk::{bs58, transaction::Transaction};

use crate::{HeliusPriorityFeeLevel, HeliusPriorityFeeOracleConfig};

#[async_trait]
pub trait PriorityFeeOracle: Send + Sync {
    async fn get_priority_fee(&self, transaction: &Transaction) -> ChainResult<u64>;
}

#[derive(Debug, Clone)]
pub struct ConstantPriorityFeeOracle {
    fee: u64,
}

impl ConstantPriorityFeeOracle {
    pub fn new(fee: u64) -> Self {
        Self { fee }
    }
}

#[async_trait]
impl PriorityFeeOracle for ConstantPriorityFeeOracle {
    async fn get_priority_fee(&self, _transaction: &Transaction) -> ChainResult<u64> {
        Ok(self.fee)
    }
}

#[derive(Debug, Clone)]
pub struct HeliusPriorityFeeOracle {
    client: Client,
    config: HeliusPriorityFeeOracleConfig,
}

impl HeliusPriorityFeeOracle {
    pub fn new(config: HeliusPriorityFeeOracleConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            config,
        }
    }
}

#[async_trait]
impl PriorityFeeOracle for HeliusPriorityFeeOracle {
    async fn get_priority_fee(&self, transaction: &Transaction) -> ChainResult<u64> {
        let base58_tx = bs58::encode(
            bincode::serialize(transaction).map_err(ChainCommunicationError::from_other)?,
        )
        .into_string();

        let request_body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "1",
            "method": "getPriorityFeeEstimate",
            "params": [
                {
                    "transaction": base58_tx,
                    "options": {
                        "includeAllPriorityFeeLevels": true,
                        "transactionEncoding": "base58",
                    }
                }
            ],
        });

        let response = self
            .client
            .post(self.config.url.clone())
            .json(&request_body)
            .send()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        let response: JsonRpcResult<GetPriorityFeeEstimateResult> = response
            .json()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        tracing::warn!(priority_fee_levels = ?response.result.priority_fee_levels, "Fetched priority fee levels");

        let fee = response
            .result
            .priority_fee_levels
            .get_priority_fee(&self.config.fee_level)
            .ok_or_else(|| ChainCommunicationError::from_other_str("Priority fee level not found"))?
            .round() as u64;

        Ok(fee)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcResult<T> {
    jsonrpc: String,
    id: String,
    result: T,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GetPriorityFeeEstimateResult {
    priority_fee_levels: PriorityFeeLevelsResponse,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PriorityFeeLevelsResponse {
    min: Option<f64>,
    low: Option<f64>,
    medium: Option<f64>,
    high: Option<f64>,
    very_high: Option<f64>,
    unsafe_max: Option<f64>,
}

impl PriorityFeeLevelsResponse {
    fn get_priority_fee(&self, level: &HeliusPriorityFeeLevel) -> Option<f64> {
        match level {
            HeliusPriorityFeeLevel::Min => self.min,
            HeliusPriorityFeeLevel::Low => self.low,
            HeliusPriorityFeeLevel::Medium => self.medium,
            HeliusPriorityFeeLevel::High => self.high,
            HeliusPriorityFeeLevel::VeryHigh => self.very_high,
            HeliusPriorityFeeLevel::UnsafeMax => self.unsafe_max,
        }
    }
}

#[cfg(test)]
mod test {
    use solana_sdk::{bs58, transaction::Transaction};

    use crate::priority_fee::{PriorityFeeLevelsResponse, PriorityFeeOracle};

    use super::{GetPriorityFeeEstimateResult, JsonRpcResult};

    #[tokio::test]
    async fn test_helius_get_priority_fee() {
        let helius_url = if let Ok(url) = std::env::var("HELIUS_URL") {
            url
        } else {
            // Skip test if HELIUS_URL is not set
            return;
        };

        let oracle = super::HeliusPriorityFeeOracle::new(super::HeliusPriorityFeeOracleConfig {
            url: url::Url::parse(&helius_url).unwrap(),
            fee_level: super::HeliusPriorityFeeLevel::Medium,
        });

        // Example process transaction
        // https://solscan.io/tx/W9fXtRD8mPkkUmuoLi9QxSCgFuy32rCVa8kfxtPjWXWRH2D1AWzuDEGuvexWGyWhQDXnEmaADZMeYu5RVjWZyAB
        let process_tx_base58 = "BPBE2dE4sPJX3nm4svEZ181qBfX9yvUp5H67uTt3aqRGtC6a77hW5vrQk9zJ3KkNuK63KoJCeqp1kkFwsbF5KL1UHf5Hrj8GXpiRxmKD8NybEZUWhjdVW9azMxJdnxxiFqH7wFQtZGkQxhx6oJz1qi5Xc64LEbPJEwSTAp5US1VCnnhWGRqJ297kvS8hWaVLuUxr4jEqYNG2LSusXZmzABBqEvRv753PBxcKiBE2moo9VKZ8n3ai6rmQGnSzsoAfwnjCx6iUdNSWqpYFHcq2xhMXJx8US5kv837KsT5tKQBbujsWUoRGGJ8vkmm7RJSYyR3DYEMa5ira9fiDwnK5qP3EgP2hrG73YYBxZ9naRrYzHG2GiEGWEUgNPHaUtK3JsbjTLiNjyZU8ERTdMxi4rBLppREJfHDWYUNgN9hTL81LYv4YoJY3UUTQphzT268f6oZoiyavngb8t3Lq8pbyc3gPiw7AcWXmn2ERDAcHvS59AaoxxcwZyn8UWUdynwCzvNbWhb97qVHSzBY1S79sxHFuqyBhbbD5YhkMhFGLjPUEDvncxE2hLt9iQCQaEQzCNRMmnZw7yJ1YxoKDKfmUTXJ6rmT4p2pz7f8x4jJwQ2pC2YxobcfHrNvD7929vXSvpomyZmaEXYAN2bqGBUe2KazpnobVCwafjKMVN4AaTJRMTXi92VKuShuKJEuZo9ZM7TScEqRZC5hLFU8SbCdASEUoQjpDzivUf1m9gQtT2ob5FPwJzcuZpqTWgixd59BRHTB1L5c4fDvtYr1QJFpJRN4DsXGryK4eTMu2oAs3imGpg1rHRLpuBTbcrchEivz7bD17bBj8VeHogfkPcehD9yaHzmYPRF47aWZ52GSFSSpc5kJRRQyghUKNPFBnycLGAbfkRYDdVzUgdrr3CNYksJCu45TChg54tMWWwrqSD3k5RPv7A6bXbAH4PzW83vzE2vGJFYpwUgNEnjuA1rVnYJHXsFdWBrqrsz3UvdTs5kUxyoxjNNKvoXSaTeXMXEt1HUdmQ3sw1dW9wRkYdHwWzksM6n7P7MLnVY6qv3BVUpJiX4K355BXhMhyozzcBQX2vvyC7J8UxPBofMrBRVtbMsXmfp3sphos1pog6wpN2MiEaJqm6KK5yQguANnQzN8mK7MREkjYXtCnczf84CrcHqpp2onQUaR4TPn8zCPVAxY4HVkCoDWTwKj8Am9M4L3a7wmF37epgKnQuypTH7dqbJPRTALe7tndrtvJCuoTFP8wPXQXxvwnBPXeLmhK9E2mpskTA33KfqvVBu4R5SFYNtGoKbvuHaDf83Lf2xx1YPUogXuEWZMx5zcaHWMmvutpfdnPe3Rb7GL4hPVKj4t9MNgiAg3QbjaR9nqYBUPT4kUpxVCJWEadDVh5pgLwnkg4DJ5ArNfgH5";
        let process_tx_bytes = bs58::decode(process_tx_base58).into_vec().unwrap();
        let transaction: Transaction = bincode::deserialize(&process_tx_bytes).unwrap();

        oracle.get_priority_fee(&transaction).await.unwrap();
    }

    #[test]
    fn test_helius_get_priority_fee_estimate_deser() {
        let text = r#"{"jsonrpc":"2.0","result":{"priorityFeeLevels":{"min":0.0,"low":0.0,"medium":1000.0,"high":225000.0,"veryHigh":9000000.0,"unsafeMax":2340000000.0}},"id":"1"}"#;
        let response: JsonRpcResult<GetPriorityFeeEstimateResult> =
            serde_json::from_str(text).unwrap();

        let expected = GetPriorityFeeEstimateResult {
            priority_fee_levels: PriorityFeeLevelsResponse {
                min: Some(0.0),
                low: Some(0.0),
                medium: Some(1000.0),
                high: Some(225000.0),
                very_high: Some(9000000.0),
                unsafe_max: Some(2340000000.0),
            },
        };
        assert_eq!(response.result, expected);
    }
}
