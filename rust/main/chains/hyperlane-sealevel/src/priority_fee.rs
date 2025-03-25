use async_trait::async_trait;
use derive_new::new;
use hyperlane_core::{ChainCommunicationError, ChainResult};
use reqwest::Client;
use serde::Deserialize;
use solana_sdk::{bs58, transaction::Transaction};

use crate::{HeliusPriorityFeeLevel, HeliusPriorityFeeOracleConfig};

/// A trait for fetching the priority fee for a transaction.
#[async_trait]
pub trait PriorityFeeOracle: Send + Sync {
    /// Fetch the priority fee in microlamports for a transaction.
    async fn get_priority_fee(&self, transaction: &Transaction) -> ChainResult<u64>;
}

/// A priority fee oracle that returns a constant fee.
#[derive(Debug, Clone, new)]
pub struct ConstantPriorityFeeOracle {
    fee: u64,
}

#[async_trait]
impl PriorityFeeOracle for ConstantPriorityFeeOracle {
    async fn get_priority_fee(&self, _transaction: &Transaction) -> ChainResult<u64> {
        Ok(self.fee)
    }
}

/// A priority fee oracle that fetches the fee from the Helius API.
/// https://docs.helius.dev/solana-apis/priority-fee-api
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

    fn get_priority_fee_estimate_options(&self) -> serde_json::Value {
        // It's an odd interface, but if using the Recommended fee level, the API requires `recommended: true`,
        // otherwise it requires `priorityLevel: "<PascalCaseFeeLevel>"`.

        let (key, value) = match &self.config.fee_level {
            HeliusPriorityFeeLevel::Recommended => ("recommended", serde_json::json!(true)),
            level => ("priorityLevel", serde_json::json!(level)),
        };

        serde_json::json!({
            key: value,
            "transactionEncoding": "base58",
        })
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
                    "options": self.get_priority_fee_estimate_options(),
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

        tracing::debug!(?response, "Fetched priority fee from Helius API");

        let fee = response.result.priority_fee_estimate.round() as u64;

        Ok(fee)
    }
}

/// The result of a JSON-RPC request to the Helius API.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcResult<T> {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: String,
    result: T,
}

/// The result of a `getPriorityFeeEstimate` request to the Helius API.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GetPriorityFeeEstimateResult {
    priority_fee_estimate: f64,
}

#[cfg(test)]
mod test {
    use solana_sdk::{bs58, transaction::Transaction};

    use crate::{
        priority_fee::{HeliusPriorityFeeOracle, PriorityFeeOracle},
        HeliusPriorityFeeLevel, HeliusPriorityFeeOracleConfig,
    };

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
    fn test_helius_get_priority_fee_estimate_options_ser() {
        let get_oracle = |fee_level| {
            HeliusPriorityFeeOracle::new(HeliusPriorityFeeOracleConfig {
                url: url::Url::parse("http://localhost:8080").unwrap(),
                fee_level,
            })
        };

        // When the fee level is Recommended, ensure `recommended` is set to true
        let oracle = get_oracle(HeliusPriorityFeeLevel::Recommended);

        let options = oracle.get_priority_fee_estimate_options();
        let expected = serde_json::json!({
            "recommended": true,
            "transactionEncoding": "base58",
        });
        assert_eq!(options, expected);

        // When the fee level is not Recommended, ensure `priorityLevel` is set
        let oracle = get_oracle(HeliusPriorityFeeLevel::Medium);

        let options = oracle.get_priority_fee_estimate_options();
        let expected = serde_json::json!({
            "priorityLevel": "Medium",
            "transactionEncoding": "base58",
        });
        assert_eq!(options, expected);

        // Ensure the serialization of HeliusPriorityFeeLevel is PascalCase,
        // as required by the API https://docs.helius.dev/solana-apis/priority-fee-api#helius-priority-fee-api
        let serialized = serde_json::json!([
            HeliusPriorityFeeLevel::Recommended,
            HeliusPriorityFeeLevel::Min,
            HeliusPriorityFeeLevel::Low,
            HeliusPriorityFeeLevel::Medium,
            HeliusPriorityFeeLevel::High,
            HeliusPriorityFeeLevel::VeryHigh,
            HeliusPriorityFeeLevel::UnsafeMax,
        ]);
        let expected = serde_json::json!([
            "Recommended",
            "Min",
            "Low",
            "Medium",
            "High",
            "VeryHigh",
            "UnsafeMax"
        ]);
        assert_eq!(serialized, expected);
    }

    #[test]
    fn test_helius_get_priority_fee_estimate_deser() {
        let text = r#"{"jsonrpc":"2.0","result":{"priorityFeeEstimate":1000.0},"id":"1"}"#;
        let response: JsonRpcResult<GetPriorityFeeEstimateResult> =
            serde_json::from_str(text).unwrap();

        let expected = GetPriorityFeeEstimateResult {
            priority_fee_estimate: 1000.0,
        };
        assert_eq!(response.result, expected);
    }
}
