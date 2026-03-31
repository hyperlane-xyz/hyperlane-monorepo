use std::time::Duration;

use ethers::providers::Http;
use ethers_core::k256::sha2::{Digest, Sha256};
use prost::Message;
use reqwest::Client;
use tron_rs::tron::protocol::transaction;
use url::Url;

use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, PrometheusJsonRpcClient};
use hyperlane_core::{rpc_clients::FallbackProvider, ChainCommunicationError, ChainResult, H256};
use hyperlane_ethereum::EthereumFallbackProvider;
use hyperlane_metric::prometheus_metric::{
    self, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use reqwest_utils::parse_custom_rpc_headers;

use crate::HyperlaneTronError;

const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

/// Returns the ref block bytes according to the specification here: https://developers.tron.network/docs/faq#19-how-to-set-reference-block-information-for-a-transaction
pub(crate) fn calculate_ref_block_bytes(number: i64) -> Vec<u8> {
    let last_2_bytes = (number & 0xFFFF) as u16;
    last_2_bytes.to_be_bytes().into()
}
/// Get bytes 8..16 of the blockid more info here: https://developers.tron.network/docs/faq#19-how-to-set-reference-block-information-for-a-transaction
pub(crate) fn calculate_ref_block_hash(hash: &[u8]) -> Vec<u8> {
    hash[8..16].into()
}

pub(crate) fn calculate_txid(raw_data: &transaction::Raw) -> H256 {
    let bytes = raw_data.encode_to_vec();
    let digest = Sha256::digest(bytes);
    let hash: [u8; 32] = digest.into();
    hash.into()
}

pub(crate) type JsonProvider = EthereumFallbackProvider<
    PrometheusJsonRpcClient<Http>,
    JsonRpcBlockGetter<PrometheusJsonRpcClient<Http>>,
>;

pub(crate) fn build_fallback_provider(
    rpcs: &Vec<Url>,
    metrics: PrometheusClientMetrics,
    chain: Option<prometheus_metric::ChainInfo>,
) -> ChainResult<JsonProvider> {
    let mut builder = FallbackProvider::builder();
    for url in rpcs {
        let http_provider = build_http_provider(url.clone())?;
        let metrics_provider =
            wrap_rpc_with_metrics(http_provider, url.clone(), metrics.clone(), chain.clone());
        builder = builder.add_provider(metrics_provider);
    }
    let fallback_provider = builder.build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);

    Ok(ethereum_fallback_provider)
}

/// Wrap a JsonRpcClient with metrics for use with a quorum provider.
fn wrap_rpc_with_metrics<C>(
    client: C,
    url: Url,
    metrics: PrometheusClientMetrics,
    chain: Option<prometheus_metric::ChainInfo>,
) -> PrometheusJsonRpcClient<C> {
    PrometheusJsonRpcClient::new(
        client,
        metrics,
        PrometheusConfig::from_url(&url, ClientConnectionType::Rpc, chain),
    )
}

fn build_http_provider(url: Url) -> ChainResult<Http> {
    let client = get_reqwest_client(&url)?;
    Ok(Http::new_with_client(url, client))
}

/// Gets a cached reqwest client for the given URL, or builds a new one if it doesn't exist.
fn get_reqwest_client(url: &Url) -> ChainResult<Client> {
    let (headers, _) =
        parse_custom_rpc_headers(url).map_err(ChainCommunicationError::from_other)?;
    let client = Client::builder()
        .timeout(HTTP_CLIENT_TIMEOUT)
        .default_headers(headers)
        .build()
        .map_err(HyperlaneTronError::from)?;

    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_ref_block_bytes() {
        // Test case 1: typical block number
        let block_number = 0x123456;
        let result = calculate_ref_block_bytes(block_number);
        assert_eq!(result, vec![0x34, 0x56]);

        // Test case 2: small block number
        let block_number = 0x00AB;
        let result = calculate_ref_block_bytes(block_number);
        assert_eq!(result, vec![0x00, 0xAB]);

        // Test case 3: max u16 value
        let block_number = 0xFFFF;
        let result = calculate_ref_block_bytes(block_number);
        assert_eq!(result, vec![0xFF, 0xFF]);

        // Test case 4: zero
        let block_number = 0;
        let result = calculate_ref_block_bytes(block_number);
        assert_eq!(result, vec![0x00, 0x00]);
    }

    #[test]
    fn test_calculate_ref_block_hash() {
        // Test case 1: hash with sufficient bytes
        let hash = vec![
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D,
            0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13,
        ];
        let result = calculate_ref_block_hash(&hash);
        assert_eq!(result, vec![0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F]);

        // Test case 2: exactly 32 bytes (typical hash size)
        let hash = vec![0xFF; 32];
        let result = calculate_ref_block_hash(&hash);
        assert_eq!(result, vec![0xFF; 8]);
    }

    #[test]
    fn test_calculate_txid() {
        // Test case 1: empty raw data
        let raw_data = transaction::Raw::default();
        let result = calculate_txid(&raw_data);
        assert_eq!(
            result,
            H256::from([
                0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f,
                0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b,
                0x78, 0x52, 0xb8, 0x55
            ])
        );

        // Test case 2: raw data with timestamp
        let mut raw_data = transaction::Raw::default();
        raw_data.timestamp = 1234567890;
        let result = calculate_txid(&raw_data);
        let expected = H256::from_slice(
            &hex::decode("c298c24fefcbed12b8d688a7488ae8d46fced9561ac9bcab75dc61a66c02c5dc")
                .unwrap(),
        );
        assert_eq!(result, expected);
    }
}
