use std::{collections::HashMap, time::{Instant, Duration}};

use abacus_core::db::{AbacusDB, DbError};
use async_trait::async_trait;
use coingecko::CoinGeckoClient;
use ethers::types::U256;
use eyre::{Result, bail, eyre};
use futures_util::future::join_all;
use gelato::{oracle_estimate::{OracleEstimateCall, OracleEstimateArgs}, NATIVE_FEE_TOKEN_ADDRESS};

use crate::msg::gelato_submitter::abacus_domain_to_gelato_chain;

use super::GasPaymentEnforcer;

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
    usd_prices: HashMap<&'static str, CachedValue<f64>>,
}

impl CoinGeckoCachingPriceGetter {
    async fn get_usd_price(&mut self, coingecko_id: &'static str) -> Result<f64> {
        if let Some(cached_value) = self.usd_prices.get(coingecko_id) {
            if cached_value.created_at.elapsed() > Duration::from_secs(CACHE_TTL_SECONDS) {
                return Ok(cached_value.value);
            }
        }
        // Returns a HashMap keyed by coingecko IDs
        let api_response = self.coingecko.price(
            &[coingecko_id],
            &["usd"],
            false,
            false,
            false,
            false,
        ).await?;
        let usd_price = api_response
            .get(coingecko_id)
            .and_then(|p| p.usd)
            .ok_or(eyre!("Unable to get USD price for {} from CoinGecko API response", coingecko_id))?;

        self.usd_prices.insert(coingecko_id, usd_price.into());

        Ok(usd_price)
    }
}

pub struct GelatoGasPaymentEnforcer {
    db: AbacusDB,
    http: reqwest::Client,
    coingecko_price_getter: CoinGeckoCachingPriceGetter,
}

impl GelatoGasPaymentEnforcer {
    pub fn new(db: AbacusDB, http: reqwest::Client) -> Self {
        Self {
            db,
            http,
            coingecko_price_getter: CoinGeckoCachingPriceGetter::default(),
        }
    }

    async fn get_native_token_usd_price(&mut self, domain: u32) -> Result<f64> {
        let coingecko_id = abacus_domain_to_native_token_coingecko_id(domain)?;
        self.coingecko_price_getter.get_usd_price(coingecko_id).await
    }

    async fn convert_native_tokens(&mut self, amount: U256, from_domain: u32, to_domain: u32) -> Result<U256> {
        let from_domain_usd_price = self.get_native_token_usd_price(from_domain).await?;
        let to_domain_usd_price = self.get_native_token_usd_price(to_domain).await?;
        


        todo!()
    }

    async fn estimate_gelato_payment(&self, destination_domain: u32, tx_gas_limit: U256) -> Result<U256> {
        let destination_chain = abacus_domain_to_gelato_chain(destination_domain)?;

        let call = OracleEstimateCall {
            http: self.http.clone(),
            args: OracleEstimateArgs {
                chain_id: destination_chain,
                payment_token: NATIVE_FEE_TOKEN_ADDRESS,
                gas_limit: tx_gas_limit.as_u64(),
                is_high_priority: false,
                gas_limit_l1: None,
            },
        };
        let result = call.run().await?;

        return Ok(result.estimated_fee);
    }
}

#[async_trait]
impl GasPaymentEnforcer for GelatoGasPaymentEnforcer {
    /// Returns (gas payment requirement met, current payment according to the DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        msg_leaf_index: u32,
        tx_gas_limit: U256,
    ) -> Result<(bool, U256), DbError> {
        let current_payment = self.get_message_gas_payment(msg_leaf_index)?;



        Ok((true, current_payment))
    }

    fn get_message_gas_payment(&self, msg_leaf_index: u32) -> Result<U256, DbError> {
        self.db.retrieve_gas_payment_for_leaf(msg_leaf_index)
    }
}

fn f64_to_fixed_point(f: f64, decimals: usize) -> U256 {
    U256::from_f64_lossy(f * )
}
