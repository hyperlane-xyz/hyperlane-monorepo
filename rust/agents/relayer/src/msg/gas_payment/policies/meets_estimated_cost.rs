use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use abacus_core::{AbacusDomain, CommittedMessage, TxCostEstimate};
use async_trait::async_trait;
use coingecko::CoinGeckoClient;
use ethers::types::U256;
use eyre::{eyre, Result};
use tokio::{sync::RwLock, time::timeout};

use crate::msg::gas_payment::GasPaymentPolicy;

const COINGECKO_API_HTTP_TIMEOUT_SECONDS: u64 = 30;
const CACHE_TTL_SECONDS: u64 = 60;
/// 1 / 100th of a cent
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

/// Given a domain, gets the CoinGecko ID for the native token.
/// If the domain isn't a mainnet (and therefore doesn't have a native
/// token with a CoinGecko ID), an Err is returned.
fn abacus_domain_id_to_native_token_coingecko_id(domain_id: u32) -> Result<&'static str> {
    let abacus_domain = AbacusDomain::try_from(domain_id)?;

    Ok(match abacus_domain {
        AbacusDomain::Ethereum => "ethereum",
        AbacusDomain::Polygon => "matic-network",
        AbacusDomain::Avalanche => "avalanche-2",
        // Arbitrum's native token is Ethereum
        AbacusDomain::Arbitrum => "ethereum",
        // Optimism's native token is Ethereum
        AbacusDomain::Optimism => "ethereum",
        AbacusDomain::BinanceSmartChain => "binancecoin",
        AbacusDomain::Celo => "celo",
        AbacusDomain::Moonbeam => "moonbeam",
        _ => eyre::bail!("No CoinGecko ID for domain {abacus_domain}"),
    })
}

/// Gets prices from CoinGecko quoted in USD, caching them with a TTL.
#[derive(Default)]
struct CoinGeckoCachingPriceGetter {
    coingecko: CoinGeckoClient,
    cache_ttl: Duration,
    /// Keyed by CoinGecko API ID. RwLock to be thread-safe.
    cached_usd_prices: RwLock<HashMap<&'static str, CachedValue<f64>>>,
}

impl std::fmt::Debug for CoinGeckoCachingPriceGetter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CoinGeckoCachingPriceGetter {{ .. }}",)
    }
}

impl CoinGeckoCachingPriceGetter {
    pub fn new(cache_ttl: Duration, coingecko_api_key: Option<String>) -> Self {
        let coingecko = if let Some(api_key) = coingecko_api_key {
            CoinGeckoClient::new_with_key("https://pro-api.coingecko.com/api/v3".into(), api_key)
        } else {
            CoinGeckoClient::new("https://api.coingecko.com/api/v3".into())
        };

        Self {
            cache_ttl,
            coingecko,
            cached_usd_prices: RwLock::default(),
        }
    }

    async fn get_cached_usd_price(&self, coingecko_id: &'static str) -> Option<f64> {
        let cached_usd_prices = self.cached_usd_prices.read().await;

        if let Some(cached_value) = cached_usd_prices.get(coingecko_id) {
            if cached_value.created_at.elapsed() <= self.cache_ttl {
                return Some(cached_value.value);
            }
        }

        None
    }

    async fn set_cached_usd_price(&self, coingecko_id: &'static str, usd_price: f64) {
        let mut cached_usd_prices = self.cached_usd_prices.write().await;
        cached_usd_prices.insert(coingecko_id, usd_price.into());
    }

    async fn get_coingecko_usd_price(&self, coingecko_id: &'static str) -> Result<f64> {
        // Make the API request with a timeout, which can't be configured in the library we're using.
        // Returns a HashMap keyed by coingecko IDs.
        let api_response = timeout(
            Duration::from_secs(COINGECKO_API_HTTP_TIMEOUT_SECONDS),
            self.coingecko
                .price(&[coingecko_id], &["usd"], false, false, false, false),
        )
        .await??;
        api_response
            .get(coingecko_id)
            .and_then(|p| p.usd)
            .ok_or_else(|| {
                eyre!(
                    "Unable to get USD price for {} from CoinGecko API response",
                    coingecko_id
                )
            })
    }

    async fn get_usd_price(&self, coingecko_id: &'static str) -> Result<f64> {
        if let Some(usd_price) = self.get_cached_usd_price(coingecko_id).await {
            return Ok(usd_price);
        }

        let usd_price = self.get_coingecko_usd_price(coingecko_id).await?;
        self.set_cached_usd_price(coingecko_id, usd_price).await;

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
            coingecko_price_getter: CoinGeckoCachingPriceGetter::new(
                Duration::from_secs(CACHE_TTL_SECONDS),
                coingecko_api_key,
            ),
        }
    }

    async fn get_native_token_usd_price(&self, domain: u32) -> Result<f64> {
        let coingecko_id = abacus_domain_id_to_native_token_coingecko_id(domain)?;
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

        let meets_requirement = *current_payment >= origin_token_tx_cost;
        tracing::info!(
            message_leaf_index=?message.leaf_index,
            tx_cost_estimate=?tx_cost_estimate,
            destination_token_tx_cost=?destination_token_tx_cost,
            origin_token_tx_cost=?origin_token_tx_cost,
            current_payment=?current_payment,
            meets_requirement=?meets_requirement,
            "Evaluated whether message gas payment meets estimated cost",
        );

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

#[tokio::test]
async fn test_gas_payment_policy_meets_estimated_cost() {
    use abacus_core::AbacusMessage;
    use ethers::types::H256;

    // Using a fake message from Celo -> Polygon, based off
    // hardcoded tx cost estimates and prices, assert that a payment
    // that doesn't meet the expected costs returns false, and a payment
    // that does returns true.

    let celo_price = 5.5f64;
    let polygon_price = 11.0f64;
    let celo_domain_id = u32::from(AbacusDomain::Celo);
    let polygon_domain_id = u32::from(AbacusDomain::Polygon);

    // Take advantage of the coingecko_price_getter caching already-stored values
    // by just writing to them directly.
    // This is a little sketchy because if the cache TTL does elapse, an API
    // request could be made. Because this TTL is 60 seconds, this isn't reasonable.
    let policy = GasPaymentPolicyMeetsEstimatedCost::new(None);
    {
        let mut usd_prices = policy
            .coingecko_price_getter
            .cached_usd_prices
            .write()
            .await;
        let celo_coingecko_id =
            abacus_domain_id_to_native_token_coingecko_id(celo_domain_id).unwrap();
        let polygon_coingecko_id =
            abacus_domain_id_to_native_token_coingecko_id(polygon_domain_id).unwrap();

        usd_prices.insert(celo_coingecko_id, celo_price.into());
        usd_prices.insert(polygon_coingecko_id, polygon_price.into());
    }

    let message = CommittedMessage {
        leaf_index: 10u32,
        message: AbacusMessage {
            origin: celo_domain_id,
            destination: polygon_domain_id,
            sender: H256::zero(),
            recipient: H256::zero(),
            body: vec![],
        },
    };
    let tx_cost_estimate = TxCostEstimate {
        // 1M gas
        gas_limit: U256::from(1000000u32),
        // 15 gwei
        gas_price: ethers::utils::parse_units("15", "gwei").unwrap().into(),
    };

    // Expected polygon fee: 1M * 15 gwei = 0.015 MATIC
    // Converted into Celo, 0.015 MATIC * ($11 / $5.5) = 0.03 CELO
    let required_celo_payment = ethers::utils::parse_ether("0.03").unwrap();

    // Any less than 0.03 CELO as payment, return false.
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &(required_celo_payment - U256::one()),
                &tx_cost_estimate,
            )
            .await
            .unwrap(),
        false,
    );

    // If the payment is at least 0.03 CELO, return true.
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &required_celo_payment,
                &tx_cost_estimate,
            )
            .await
            .unwrap(),
        true,
    );
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

#[test]
fn test_abacus_domain_id_to_native_token_coingecko_id() {
    use abacus_core::AbacusDomainType;
    use strum::IntoEnumIterator;

    // Iterate through all AbacusDomains, ensuring all mainnet domains
    // are included in abacus_domain_id_to_native_token_coingecko_id.
    for abacus_domain in AbacusDomain::iter() {
        if let AbacusDomainType::Mainnet = abacus_domain.domain_type() {
            assert!(
                abacus_domain_id_to_native_token_coingecko_id(u32::from(abacus_domain)).is_ok()
            );
        }
    }
}
