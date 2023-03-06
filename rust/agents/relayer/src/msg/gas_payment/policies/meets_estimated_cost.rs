use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use coingecko::CoinGeckoClient;
use eyre::{eyre, Result};
use tokio::{sync::RwLock, time::timeout};
use tracing::{debug, info};

use hyperlane_core::{
    HyperlaneMessage, InterchainGasExpenditure, InterchainGasPayment, KnownHyperlaneDomain,
    TxCostEstimate, U256,
};

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
fn hyperlane_domain_id_to_native_token_coingecko_id(domain_id: u32) -> Result<&'static str> {
    use KnownHyperlaneDomain::*;
    let hyperlane_domain = KnownHyperlaneDomain::try_from(domain_id)?;

    Ok(match hyperlane_domain {
        Ethereum => "ethereum",
        Polygon => "matic-network",
        Avalanche => "avalanche-2",
        // Arbitrum's native token is Ethereum
        Arbitrum => "ethereum",
        // Optimism's native token is Ethereum
        Optimism => "ethereum",
        BinanceSmartChain => "binancecoin",
        Celo => "celo",
        Moonbeam => "moonbeam",
        Gnosis => "xdai",
        _ => eyre::bail!("No CoinGecko ID for domain {hyperlane_domain}"),
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
        // Make the API request with a timeout, which can't be configured in the library
        // we're using. Returns a HashMap keyed by coingecko IDs.
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
        let coingecko_id = hyperlane_domain_id_to_native_token_coingecko_id(domain)?;
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
    async fn message_meets_gas_payment_requirement(
        &self,
        message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        current_expenditure: &InterchainGasExpenditure,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        // Estimated cost of the process tx, quoted in destination native tokens
        let destination_token_tx_cost = (tx_cost_estimate.enforceable_gas_limit()
            * tx_cost_estimate.gas_price)
            + current_expenditure.tokens_used;
        // Convert the destination token tx cost into origin tokens
        let origin_token_tx_cost = self
            .convert_native_tokens(
                destination_token_tx_cost,
                message.destination,
                message.origin,
            )
            .await?;

        let meets_requirement = current_payment.payment >= origin_token_tx_cost;
        if !meets_requirement {
            info!(
                msg=%message,
                ?tx_cost_estimate,
                ?destination_token_tx_cost,
                ?origin_token_tx_cost,
                ?current_payment,
                "Message gas payment does not meet estimated cost",
            );
        } else {
            debug!(
                msg=%message,
                ?tx_cost_estimate,
                ?destination_token_tx_cost,
                ?origin_token_tx_cost,
                ?current_payment,
                "Message gas payment meets estimated cost",
            );
        }

        if meets_requirement {
            Ok(Some(tx_cost_estimate.gas_limit))
        } else {
            Ok(None)
        }
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
    use hyperlane_core::{HyperlaneMessage, H256};

    // Using a fake message from Celo -> Polygon, based off
    // hardcoded tx cost estimates and prices, assert that a payment
    // that doesn't meet the expected costs returns false, and a payment
    // that does returns true.

    let celo_price = 5.5f64;
    let polygon_price = 11.0f64;
    let celo_domain_id = KnownHyperlaneDomain::Celo as u32;
    let polygon_domain_id = KnownHyperlaneDomain::Polygon as u32;

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
            hyperlane_domain_id_to_native_token_coingecko_id(celo_domain_id).unwrap();
        let polygon_coingecko_id =
            hyperlane_domain_id_to_native_token_coingecko_id(polygon_domain_id).unwrap();

        usd_prices.insert(celo_coingecko_id, celo_price.into());
        usd_prices.insert(polygon_coingecko_id, polygon_price.into());
    }

    let message = HyperlaneMessage {
        version: 0,
        nonce: 10u32,
        origin: celo_domain_id,
        destination: polygon_domain_id,
        sender: H256::zero(),
        recipient: H256::zero(),
        body: vec![],
    };
    let tx_cost_estimate = TxCostEstimate {
        // 1M gas
        gas_limit: U256::from(1000000u32),
        // 15 gwei
        gas_price: ethers::utils::parse_units("15", "gwei").unwrap().into(),
        l2_gas_limit: None,
    };

    // Expected polygon fee: 1M * 15 gwei = 0.015 MATIC
    // Converted into Celo, 0.015 MATIC * ($11 / $5.5) = 0.03 CELO
    let required_celo_payment = ethers::utils::parse_ether("0.03").unwrap();

    // Any less than 0.03 CELO as payment, return false.
    let current_payment = InterchainGasPayment {
        payment: required_celo_payment - U256::one(),
        message_id: H256::zero(),
        gas_amount: U256::zero(),
    };
    let zero_current_expenditure = InterchainGasExpenditure {
        message_id: H256::zero(),
        tokens_used: U256::zero(),
        gas_used: U256::zero(),
    };
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment,
                &zero_current_expenditure,
                &tx_cost_estimate,
            )
            .await
            .unwrap(),
        None
    );

    // If the payment is at least 0.03 CELO, return true.
    let current_payment = InterchainGasPayment {
        payment: required_celo_payment,
        message_id: H256::zero(),
        gas_amount: U256::zero(),
    };
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment,
                &zero_current_expenditure,
                &tx_cost_estimate,
            )
            .await
            .unwrap(),
        Some(tx_cost_estimate.gas_limit)
    );

    // but not if we have spent tokens already
    let current_expenditure = InterchainGasExpenditure {
        message_id: H256::zero(),
        tokens_used: U256::from(10u32),
        gas_used: U256::zero(),
    };
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment,
                &current_expenditure,
                &tx_cost_estimate,
            )
            .await
            .unwrap(),
        None
    );

    // If the l2_gas_limit isn't None, we use the L2 gas limit for the gas enforcement,
    // but return the full Some(gas_limit)
    let l2_tx_cost_estimate = TxCostEstimate {
        // 10M gas
        gas_limit: 10000000u32.into(),
        // 15 gwei
        gas_price: tx_cost_estimate.gas_price,
        // 100k gas
        l2_gas_limit: Some(100000u32.into()),
    };
    // First check that if the l2_gas_limit were None, we'd get None back because the
    // gas_limit is too high
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment,
                &zero_current_expenditure,
                &TxCostEstimate {
                    l2_gas_limit: None,
                    ..l2_tx_cost_estimate
                },
            )
            .await
            .unwrap(),
        None,
    );
    // And now confirm that with the l2_gas_limit as Some(100k), we get Some(gas_limit)
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment,
                &zero_current_expenditure,
                &l2_tx_cost_estimate,
            )
            .await
            .unwrap(),
        Some(l2_tx_cost_estimate.gas_limit)
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
fn test_hyperlane_domain_id_to_native_token_coingecko_id() {
    use hyperlane_core::HyperlaneDomainType;
    use strum::IntoEnumIterator;

    // Iterate through all HyperlaneDomains, ensuring all mainnet domains
    // are included in hyperlane_domain_id_to_native_token_coingecko_id.
    for hyperlane_domain in KnownHyperlaneDomain::iter() {
        if let HyperlaneDomainType::Mainnet = hyperlane_domain.domain_type() {
            assert!(
                hyperlane_domain_id_to_native_token_coingecko_id(hyperlane_domain as u32).is_ok()
            );
        }
    }
}
