use dym_kas_core::wallet::{EasyKaspaWallet, EasyKaspaWalletArgs, Network};
use eyre::Result;
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionId;
use kaspa_wallet_core::prelude::Secret;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tracing::info;

pub struct KaspaWhale {
    pub wallet: EasyKaspaWallet,
    pub secret: Secret,
    last_used: Mutex<Instant>,
    pub id: usize,
}

impl KaspaWhale {
    pub async fn deposit_with_payload(
        &self,
        address: Address,
        amt: u64,
        payload: Vec<u8>,
    ) -> Result<TransactionId> {
        dymension_kaspa::ops::user::deposit::deposit_with_payload(
            &self.wallet.wallet,
            &self.secret,
            address,
            amt,
            payload,
        )
        .await
        .map_err(Into::into)
    }

    fn mark_used(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    fn last_used(&self) -> Instant {
        *self.last_used.lock().unwrap()
    }
}

pub struct KaspaWhalePool {
    whales: Vec<Arc<KaspaWhale>>,
}

impl KaspaWhalePool {
    pub async fn new(
        secrets: Vec<String>,
        wrpc_url: String,
        net: Network,
        wallet_dir_prefix: Option<String>,
    ) -> Result<Self> {
        if secrets.is_empty() {
            return Err(eyre::eyre!("kaspa whale secrets list cannot be empty"));
        }

        info!("Initializing {} Kaspa whales", secrets.len());

        let mut whales = Vec::new();
        let base_time = Instant::now();

        for (id, secret_str) in secrets.into_iter().enumerate() {
            let storage_folder = wallet_dir_prefix
                .as_ref()
                .map(|prefix| format!("{}/{}", prefix, id));

            if let Some(ref folder) = storage_folder {
                std::fs::create_dir_all(folder)?;
            }

            let wallet = EasyKaspaWallet::try_new(EasyKaspaWalletArgs {
                wallet_secret: secret_str.clone(),
                wrpc_url: wrpc_url.clone(),
                net: net.clone(),
                storage_folder,
            })
            .await?;

            let secret = Secret::from(secret_str);

            let whale = Arc::new(KaspaWhale {
                wallet,
                secret,
                last_used: Mutex::new(base_time - std::time::Duration::from_secs(id as u64)),
                id,
            });

            whales.push(whale);

            info!("Initialized Kaspa whale: id={}", id);
        }

        info!("All {} Kaspa whales initialized", whales.len());

        Ok(Self { whales })
    }

    pub fn select_whale(&self) -> Arc<KaspaWhale> {
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
        let w1 = Arc::new(KaspaWhale {
            wallet: unsafe { std::mem::zeroed() },
            secret: Secret::from("test1".to_string()),
            last_used: Mutex::new(base - std::time::Duration::from_secs(10)),
            id: 1,
        });
        let w2 = Arc::new(KaspaWhale {
            wallet: unsafe { std::mem::zeroed() },
            secret: Secret::from("test2".to_string()),
            last_used: Mutex::new(base - std::time::Duration::from_secs(5)),
            id: 2,
        });

        let pool = KaspaWhalePool {
            whales: vec![w1.clone(), w2.clone()],
        };

        let selected = pool.select_whale();
        assert_eq!(selected.id, 1);

        let selected = pool.select_whale();
        assert_eq!(selected.id, 2);
    }
}
