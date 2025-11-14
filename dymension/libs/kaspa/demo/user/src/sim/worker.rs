use corelib::wallet::{EasyKaspaWallet, EasyKaspaWalletArgs, Network};
use eyre::Result;
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionId;

/// Worker wallet for parallel deposits
/// Each worker uses an independent temporary wallet
#[derive(Clone)]
pub struct WorkerWallet {
    pub wallet: EasyKaspaWallet,
    pub worker_id: usize,
}

impl WorkerWallet {
    /// Create a new worker wallet with its own storage
    pub async fn create_new(worker_id: usize, wrpc_url: String, net: Network) -> Result<Self> {
        // Create temporary storage folder for this worker
        let temp_dir = std::env::temp_dir();
        let worker_storage = temp_dir.join(format!(
            "kaspa-worker-{}-{}",
            worker_id,
            uuid::Uuid::new_v4()
        ));

        std::fs::create_dir_all(&worker_storage)?;

        let wallet = EasyKaspaWallet::try_new(EasyKaspaWalletArgs {
            wallet_secret: format!("worker-{}", worker_id),
            wrpc_url,
            net,
            storage_folder: Some(worker_storage.to_string_lossy().to_string()),
        })
        .await?;

        Ok(Self { wallet, worker_id })
    }

    pub fn receive_address(&self) -> Result<Address> {
        Ok(self.wallet.account().receive_address()?)
    }

    pub async fn deposit_with_payload(
        &self,
        address: Address,
        amt: u64,
        payload: Vec<u8>,
    ) -> Result<TransactionId> {
        corelib::user::deposit::deposit_with_payload(
            &self.wallet.wallet,
            &self.wallet.secret,
            address,
            amt,
            payload,
        )
        .await
        .map_err(Into::into)
    }
}
