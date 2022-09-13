use std::{collections::HashMap, time::{Instant, Duration}};

use abacus_core::db::{AbacusDB, DbError};
use async_trait::async_trait;
use ethers::types::U256;
use gelato::types::Chain;

use super::GasPaymentEnforcer;

const CACHE_TTL_SECONDS: u64 = 60;

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

#[derive(Debug)]
pub struct GelatoGasPaymentEnforcer {
    db: AbacusDB,
    exchange_rates_usdc: HashMap<Chain, CachedValue<f64>>,
}

impl GelatoGasPaymentEnforcer {
    pub fn new(db: AbacusDB) -> Self {
        Self {
            db,
            exchange_rates_usdc: HashMap::default(),
        }
    }

    async fn get_exchange_rate_usdc(&mut self, chain: Chain) -> f64 {
        if let Some(cached_value) = self.exchange_rates_usdc.get(&chain) {
            if cached_value.created_at.elapsed() > Duration::from_secs(CACHE_TTL_SECONDS) {
                return cached_value.value;
            }
        }

        let exchange_rate = 6.9f64;

        self.exchange_rates_usdc.insert(chain, exchange_rate.into());

        exchange_rate
    }
}

#[async_trait]
impl GasPaymentEnforcer for GelatoGasPaymentEnforcer {
    /// Returns (gas payment requirement met, current payment according to the DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        msg_leaf_index: u32,
    ) -> Result<(bool, U256), DbError> {
        let current_payment = self.get_message_gas_payment(msg_leaf_index)?;

        Ok((true, current_payment))
    }

    fn get_message_gas_payment(&self, msg_leaf_index: u32) -> Result<U256, DbError> {
        self.db.retrieve_gas_payment_for_leaf(msg_leaf_index)
    }
}