use super::key_cosmos::EasyHubKey;
use super::util::create_cosmos_provider;
use eyre::Result;
use hyperlane_cosmos::{native::ModuleQueryClient, CosmosProvider};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::Mutex as AsyncMutex;
use tracing::{debug, info};

pub struct HubWhale {
    pub provider: CosmosProvider<ModuleQueryClient>,
    pub last_used: Mutex<Instant>,
    pub id: usize,
    pub tx_lock: AsyncMutex<()>,
}

impl HubWhale {
    fn mark_used(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    fn last_used(&self) -> Instant {
        *self.last_used.lock().unwrap()
    }

    pub async fn lock_for_tx(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.tx_lock.lock().await
    }
}

pub struct HubWhalePool {
    whales: Vec<Arc<HubWhale>>,
}

impl HubWhalePool {
    pub async fn new(
        priv_keys: Vec<String>,
        rpc_url: String,
        grpc_url: String,
        chain_id: String,
        prefix: String,
        denom: String,
        decimals: u32,
    ) -> Result<Self> {
        if priv_keys.is_empty() {
            return Err(eyre::eyre!("hub whale private keys list cannot be empty"));
        }

        info!("Initializing {} Hub whales", priv_keys.len());

        let mut whales = Vec::new();
        let base_time = Instant::now();

        for (id, priv_key_hex) in priv_keys.into_iter().enumerate() {
            let key = EasyHubKey::from_hex(&priv_key_hex);
            let provider = create_cosmos_provider(
                &key, &rpc_url, &grpc_url, &chain_id, &prefix, &denom, decimals,
            )
            .await?;

            debug!(
                "Hub whale initialized: id={} address={}",
                id,
                key.signer().address_string
            );

            let whale = Arc::new(HubWhale {
                provider,
                last_used: Mutex::new(base_time - std::time::Duration::from_secs(id as u64)),
                id,
                tx_lock: AsyncMutex::new(()),
            });

            whales.push(whale);

            info!("Initialized Hub whale: id={}", id);
        }

        info!("All {} Hub whales initialized", whales.len());

        Ok(Self { whales })
    }

    pub fn select_whale(&self) -> Arc<HubWhale> {
        let selected = self
            .whales
            .iter()
            .min_by_key(|w| w.last_used())
            .expect("whale pool cannot be empty")
            .clone();

        selected.mark_used();
        selected
    }

    pub fn count(&self) -> usize {
        self.whales.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lru_tracking() {
        let base = Instant::now();

        let w1 = Arc::new(HubWhale {
            provider: unsafe { std::mem::zeroed() },
            last_used: Mutex::new(base - std::time::Duration::from_secs(10)),
            id: 1,
            tx_lock: AsyncMutex::new(()),
        });
        let w2 = Arc::new(HubWhale {
            provider: unsafe { std::mem::zeroed() },
            last_used: Mutex::new(base - std::time::Duration::from_secs(5)),
            id: 2,
            tx_lock: AsyncMutex::new(()),
        });

        let pool = HubWhalePool {
            whales: vec![w1.clone(), w2.clone()],
        };

        let selected = pool.select_whale();
        assert_eq!(selected.id, 1);

        let selected = pool.select_whale();
        assert_eq!(selected.id, 2);
    }
}
