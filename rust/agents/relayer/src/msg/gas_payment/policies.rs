use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use abacus_core::{CommittedMessage, TxCostEstimate};
use async_trait::async_trait;
use coingecko::CoinGeckoClient;
use ethers::types::U256;
use eyre::{bail, eyre, Result};
use tokio::sync::RwLock;

use super::GasPaymentPolicy;

#[derive(Debug)]
pub struct GasPaymentPolicyNone {}

impl GasPaymentPolicyNone {
    pub fn new() -> Self {
        Self {}
    }
}

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyNone {
    /// Returns (gas payment requirement met, current payment according to the DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &CommittedMessage,
        _current_payment: &U256,
        _tx_cost_estimate: &TxCostEstimate,
    ) -> Result<bool> {
        Ok(true)
    }
}

#[derive(Debug)]
pub struct GasPaymentPolicyMinimum {
    minimum_payment: U256,
}

impl GasPaymentPolicyMinimum {
    pub fn new(minimum_payment: U256) -> Self {
        Self { minimum_payment }
    }
}

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyMinimum {
    /// Returns (gas payment requirement met, current payment according to the DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &CommittedMessage,
        current_payment: &U256,
        _tx_cost_estimate: &TxCostEstimate,
    ) -> Result<bool> {
        Ok(*current_payment >= self.minimum_payment)
    }
}

const CACHE_TTL_SECONDS: u64 = 60;
// 1 / 100th of a cent
const FIXED_POINT_PRECISION: usize = 1000;

#[derive(Debug)]
struct CachedValue<T> {
    created_at: Instant,
    value: T,
}

impl<T> From<T> for CachedValue<T> {
    fn from(value: T) -> Self {
        Self {
            created_at: Instant::now(),
            value,
        }
    }
}

fn abacus_domain_to_native_token_coingecko_id(domain: u32) -> Result<&'static str> {
    Ok(match domain {
        // Ethereum
        6648936 => "ethereum",
        // 1634872690 => Chain::Rinkeby,
        // 3000 => Chain::Kovan,

        // Polygon
        1886350457 => "matic-network",
        // 80001 => Chain::Mumbai,

        // Avalanche
        1635148152 => "avalanche-2",
        // 43113 => Chain::Fuji,

        // Arbitrum - native token is Ethereum
        6386274 => "ethereum",
        // 421611 => Chain::ArbitrumRinkeby,

        // Optimism - native token is Ethereum
        28528 => "ethereum",
        // 1869622635 => Chain::OptimismKovan,

        // Binance Smart Chain
        6452067 => "binancecoin",
        // 1651715444 => Chain::BinanceSmartChainTestnet,

        // Celo
        1667591279 => "celo",
        // 1000 => Chain::Alfajores,
        _ => bail!("No CoinGecko ID found for domain {}", domain),
    })
}

#[derive(Default)]
struct CoinGeckoCachingPriceGetter {
    coingecko: CoinGeckoClient,
    // Keyed by coingecko id
    cached_usd_prices: RwLock<HashMap<&'static str, CachedValue<f64>>>,
}

impl std::fmt::Debug for CoinGeckoCachingPriceGetter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CoinGeckoCachingPriceGetter {{ .. }}",)
    }
}

impl CoinGeckoCachingPriceGetter {
    pub fn new(coingecko_api_key: Option<String>) -> Self {
        let coingecko = if let Some(api_key) = coingecko_api_key {
            CoinGeckoClient::new_with_key("https://pro-api.coingecko.com/api/v3".into(), api_key)
        } else {
            CoinGeckoClient::new("https://api.coingecko.com/api/v3".into())
        };

        Self {
            coingecko,
            cached_usd_prices: RwLock::default(),
        }
    }

    async fn get_cached_usd_price(&self, coingecko_id: &'static str) -> Option<f64> {
        let cached_usd_prices = self.cached_usd_prices.read().await;

        if let Some(cached_value) = cached_usd_prices.get(coingecko_id) {
            if cached_value.created_at.elapsed() > Duration::from_secs(CACHE_TTL_SECONDS) {
                return Some(cached_value.value);
            }
        }

        None
    }

    async fn set_cached_usd_price(&self, coingecko_id: &'static str, usd_price: f64) {
        let mut cached_usd_prices = self.cached_usd_prices.write().await;
        cached_usd_prices.insert(coingecko_id, usd_price.into());
    }

    async fn get_usd_price(&self, coingecko_id: &'static str) -> Result<f64> {
        if let Some(usd_price) = self.get_cached_usd_price(coingecko_id).await {
            return Ok(usd_price);
        }

        // Returns a HashMap keyed by coingecko IDs
        let api_response = self
            .coingecko
            .price(&[coingecko_id], &["usd"], false, false, false, false)
            .await?;
        let usd_price = api_response
            .get(coingecko_id)
            .and_then(|p| p.usd)
            .ok_or(eyre!(
                "Unable to get USD price for {} from CoinGecko API response",
                coingecko_id
            ))?;

        self.set_cached_usd_price(coingecko_id, usd_price.into())
            .await;

        Ok(usd_price)
    }
}

#[derive(Debug)]
pub struct GasPaymentPolicyMeetsEstimatedCost {
    coingecko_price_getter: CoinGeckoCachingPriceGetter,
}

impl GasPaymentPolicyMeetsEstimatedCost {
    pub fn new(coingecko_api_key: Option<String>) -> Self {
        Self {
            coingecko_price_getter: CoinGeckoCachingPriceGetter::new(coingecko_api_key),
        }
    }

    async fn get_native_token_usd_price(&self, domain: u32) -> Result<f64> {
        let coingecko_id = abacus_domain_to_native_token_coingecko_id(domain)?;
        self.coingecko_price_getter
            .get_usd_price(coingecko_id)
            .await
    }

    async fn convert_native_tokens(
        &self,
        amount: U256,
        from_domain: u32,
        to_domain: u32,
    ) -> Result<U256> {
        convert_tokens(
            amount,
            self.get_native_token_usd_price(from_domain).await?,
            self.get_native_token_usd_price(to_domain).await?,
        )
        .ok_or_else(|| {
            eyre!(
                "Unable to convert {} native tokens from {} to {}",
                amount,
                from_domain,
                to_domain
            )
        })
    }
}

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyMeetsEstimatedCost {
    /// Returns (gas payment requirement met, current payment according to the DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        message: &CommittedMessage,
        current_payment: &U256,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<bool> {
        // Estimated cost of the process tx, quoted in destination native tokens
        let destination_token_tx_cost = tx_cost_estimate.gas_limit * tx_cost_estimate.gas_price;
        // Convert the destination token tx cost into origin tokens
        let origin_token_tx_cost = self
            .convert_native_tokens(
                destination_token_tx_cost,
                message.message.destination,
                message.message.origin,
            )
            .await?;

        let meets_requirement = origin_token_tx_cost >= *current_payment;
        if !meets_requirement {
            tracing::info!(
                message_leaf_index=?message.leaf_index,
                tx_cost_estimate=?tx_cost_estimate,
                destination_token_tx_cost=?destination_token_tx_cost,
                origin_token_tx_cost=?origin_token_tx_cost,
                current_payment=?current_payment,
                "Estimated gas payment requirement not met",
            );
        }

        Ok(meets_requirement)
    }
}

fn f64_to_fixed_point(f: f64, precision: usize) -> U256 {
    U256::from_f64_lossy(f * precision as f64)
}

fn convert_tokens(amount: U256, from_price: f64, to_price: f64) -> Option<U256> {
    let from_price = f64_to_fixed_point(from_price, FIXED_POINT_PRECISION);
    let to_price = f64_to_fixed_point(to_price, FIXED_POINT_PRECISION);

    amount
        .checked_mul(from_price)
        .and_then(|n| n.checked_div(to_price))
}

#[test]
fn test_convert_tokens() {
    // A lowish number

    // Converting to a less valuable token
    assert_eq!(
        convert_tokens(
            // 1M
            U256::from(1000000),
            20000.0f64,
            2000.0f64,
        ),
        // 10M
        Some(U256::from(10000000)),
    );

    // Converting to a more valuable token
    assert_eq!(
        convert_tokens(
            // 10M
            U256::from(10000000),
            2000.0f64,
            20000.0f64,
        ),
        // 1M
        Some(U256::from(1000000)),
    );

    // A higher number

    // Converting to a less valuable token
    assert_eq!(
        convert_tokens(
            // 100 ether
            ethers::utils::parse_ether(100u32).unwrap(),
            20000.0f64,
            200.0f64,
        ),
        // 10000 ether
        Some(ethers::utils::parse_ether(10000u32).unwrap()),
    );

    // Converting to a more valuable token
    assert_eq!(
        convert_tokens(
            // 10000 ether
            ethers::utils::parse_ether(10000u32).unwrap(),
            200.0f64,
            20000.0f64,
        ),
        // 100 ether
        Some(ethers::utils::parse_ether(100u32).unwrap()),
    );

    // If the to_price is 0
    assert_eq!(
        convert_tokens(
            // 1M
            U256::from(1000000),
            20000.0f64,
            0f64,
        ),
        None,
    )
}
