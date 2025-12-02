use super::confirmation_queue::PendingConfirmation;
use super::validators::ValidatorsClient;
use super::RestProvider;
use crate::util::domain_to_kas_network;
use crate::withdrawal_utils::{record_withdrawal_batch_metrics, WithdrawalStage};
use crate::ConnectionConf;
use crate::RelayerStuff;
use crate::ValidatorStuff;
use dym_kas_core::confirmation::ConfirmationFXG;
use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::wallet::{EasyKaspaWallet, EasyKaspaWalletArgs};
use dym_kas_relayer::withdraw::hub_to_kaspa::combine_bundles_with_fee;
use dym_kas_relayer::withdraw::messages::on_new_withdrawals;
use dym_kas_relayer::KaspaBridgeMetrics;
use eyre::Result;
use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::NativeToken;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, HyperlaneProviderError, TxnInfo, H256, H512, U256,
};
use hyperlane_cosmos::ConnectionConf as HubConnectionConf;
use hyperlane_cosmos::RawCosmosAmount;
use hyperlane_cosmos::Signer as HyperlaneSigner;
use hyperlane_cosmos::{native::ModuleQueryClient, CosmosProvider};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
use kaspa_addresses::Address;
use kaspa_rpc_core::model::{RpcTransaction, RpcTransactionId};
use kaspa_rpc_core::notify::mode::NotificationMode;
use kaspa_wallet_core::prelude::DynRpcApi;
use prometheus::Registry;
use std::sync::Arc;
use tokio::sync::RwLock;
use tonic::async_trait;
use tracing::{error, info};
use url::Url;

struct ProcessedWithdrawals {
    fxg: std::sync::Arc<dym_kas_core::withdraw::WithdrawFXG>,
    tx_ids: Vec<RpcTransactionId>,
}

#[derive(Clone)]
pub struct KaspaProvider {
    conf: ConnectionConf,
    domain: HyperlaneDomain,
    easy_wallet: Arc<RwLock<EasyKaspaWallet>>,
    rest: RestProvider,
    validators: ValidatorsClient,
    cosmos_rpc: CosmosProvider<ModuleQueryClient>,

    // Kaspa escrow key source (Direct JSON or AWS KMS config)
    kas_key_source: Option<crate::conf::KaspaEscrowKeySource>,

    // Optimistic hint for next confirmation needed on Hub. If out of date, relayer polls Kaspa to sync
    pending_confirmation: Arc<PendingConfirmation>,

    metrics: KaspaBridgeMetrics,

    /// Kaspa database for tracking deposits/withdrawals purely for informational purposes (optional, set by relayer)
    kaspa_db: Option<Arc<dyn hyperlane_core::KaspaDb>>,

    /// gRPC client for validator operations (None for relayer)
    grpc_client: Option<kaspa_grpc_client::GrpcClient>,

    /// Cached escrow public key data computed from validator_pub_keys and address_prefix.
    /// Cached because easy_wallet is wrapped in RwLock for reconnection support, so we
    /// can't synchronously access wallet.net.address_prefix needed for EscrowPublic::from_strs().
    /// This escrow data is immutable and determined entirely by config at initialization.
    escrow: EscrowPublic,
}

impl KaspaProvider {
    pub async fn new(
        cfg: &ConnectionConf,
        domain: HyperlaneDomain,
        signer: Option<HyperlaneSigner>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
        registry: Option<&Registry>,
    ) -> ChainResult<Self> {
        let rest = RestProvider::new(cfg.clone(), signer, metrics.clone(), chain.clone())?;

        let kaspa_metrics = if let Some(reg) = registry {
            KaspaBridgeMetrics::new(reg).expect("create KaspaBridgeMetrics")
        } else {
            KaspaBridgeMetrics::new(&prometheus::default_registry())
                .expect("create default KaspaBridgeMetrics")
        };

        let validators = ValidatorsClient::new(
            cfg.clone(),
            Some(kaspa_metrics.validator_request_duration.clone()),
        )?;

        let easy_wallet = get_easy_wallet(
            domain.clone(),
            cfg.kaspa_urls_wrpc[0].clone(),
            cfg.wallet_secret.clone(),
            cfg.wallet_dir.clone(),
        )
        .await
        .map_err(|e| eyre::eyre!("create easy wallet: {}", e))?;

        let kas_key_source = cfg
            .validator_stuff
            .as_ref()
            .map(|v| v.kas_escrow_key_source.clone());

        // Create gRPC client for validator if configured
        let grpc_client = if let Some(validator_stuff) = &cfg.validator_stuff {
            let grpc_url = &validator_stuff.kaspa_grpc_urls[0]; // Use first URL, similar to wrpc
            info!(
                grpc_url = %grpc_url,
                "kaspa provider: initializing gRPC client with reconnection support"
            );
            Some(
                kaspa_grpc_client::GrpcClient::connect_with_args(
                    NotificationMode::Direct,
                    grpc_url.clone(),
                    None,  // subscription_context
                    true,  // reconnect - enable automatic reconnection
                    None,  // connection_event_sender
                    false, // override_handle_stop_notify
                    None,  // timeout_duration - use default
                    Arc::new(kaspa_utils_tower::counters::TowerConnectionCounters::default()),
                )
                .await
                .expect("create Kaspa gRPC client"),
            )
        } else {
            None
        };

        let escrow = EscrowPublic::from_strs(
            cfg.validator_pub_keys.clone(),
            easy_wallet.net.address_prefix,
            cfg.multisig_threshold_kaspa as u8,
        );

        let provider = KaspaProvider {
            domain: domain.clone(),
            conf: cfg.clone(),
            easy_wallet: Arc::new(RwLock::new(easy_wallet)),
            rest,
            validators,
            cosmos_rpc: cosmos_grpc_client(cfg.hub_grpc_urls.clone()),
            kas_key_source,
            pending_confirmation: Arc::new(PendingConfirmation::new()),
            metrics: kaspa_metrics,
            kaspa_db: None,
            grpc_client,
            escrow,
        };

        if let Err(e) = provider.update_balance_metrics().await {
            tracing::error!(error=?e, "initialize balance metrics on startup");
        }

        // Set relayer change address metric on startup
        {
            let wallet = provider.easy_wallet.read().await;
            if let Ok(change_addr) = wallet.account().change_address() {
                provider
                    .metrics()
                    .relayer_receive_address_info
                    .with_label_values(&[&change_addr.to_string()])
                    .set(1.0);
            }
        }

        Ok(provider)
    }

    pub fn kaspa_db(&self) -> Option<&Arc<dyn hyperlane_core::KaspaDb>> {
        self.kaspa_db.as_ref()
    }

    pub fn set_kaspa_db(&mut self, kaspa_db: Arc<dyn hyperlane_core::KaspaDb>) {
        self.kaspa_db = Some(kaspa_db);
    }

    pub fn hack_store_withdrawals_for_query(&self, withdrawals: &Vec<HyperlaneMessage>) {
        // Store withdrawal messages in kaspa_db before processing
        if let Some(kaspa_db) = self.kaspa_db() {
            for msg in withdrawals {
                let message_id = format!("0x{:x}", msg.id());
                match kaspa_db.store_withdrawal_message(msg.clone()) {
                    Ok(()) => {
                        info!(
                            message_id = %message_id,
                            "Stored withdrawal message in kaspa_db"
                        );
                    }
                    Err(e) => {
                        error!(
                            message_id = %message_id,
                            error = ?e,
                            "store withdrawal message in kaspa_db"
                        );
                    }
                }
            }
        } else {
            error!("kaspa mailbox: no kaspa_db set, skipping storing withdrawal messages");
        }
    }

    /// Store withdrawal messages and their kaspa transaction IDs in the database
    pub fn hack_store_withdrawals_kaspa_tx_for_query(
        &self,
        withdrawals: &[(HyperlaneMessage, String)],
    ) {
        if let Some(kaspa_db) = &self.kaspa_db {
            for (msg, kaspa_tx) in withdrawals {
                if !kaspa_tx.is_empty() {
                    let message_id = msg.id();
                    // Store kaspa_tx for the withdrawal
                    if let Err(e) = kaspa_db.store_withdrawal_kaspa_tx(&message_id, kaspa_tx) {
                        error!(
                            message_id = ?message_id,
                            kaspa_tx = %kaspa_tx,
                            error = ?e,
                            "store kaspa_tx for withdrawal"
                        );
                    } else {
                        info!(
                            message_id = ?message_id,
                            kaspa_tx = %kaspa_tx,
                            "Stored withdrawal in kaspa_db"
                        );
                    }
                }
            }
        }
    }

    /// Store a deposit message in the database with the corresponding kaspa tx as deposit id
    pub fn store_deposit(&self, message: &hyperlane_core::HyperlaneMessage, kaspa_tx_id: &str) {
        if let Some(db) = &self.kaspa_db {
            let message_id = message.id();
            info!(
                kaspa_tx_id = %kaspa_tx_id,
                message_id = ?message_id,
                nonce = message.nonce,
                "Storing deposit message in database"
            );
            match db.store_deposit_message(message.clone(), kaspa_tx_id.to_string()) {
                Ok(()) => {
                    info!(
                        message_id = ?message_id,
                        kaspa_tx_id = %kaspa_tx_id,
                        "Successfully stored deposit message"
                    );
                }
                Err(e) => {
                    error!(
                        error = ?e,
                        message_id = ?message_id,
                        kaspa_tx_id = %kaspa_tx_id,
                        "store deposit message in database"
                    );
                }
            }
        } else {
            error!("no database available for storing deposit message");
        }
    }

    /// Update a stored deposit with the new HyperlaneMessage and Hub transaction ID after successful submission
    /// Stores the new message and hub_tx
    pub fn update_processed_deposit(
        &self,
        kaspa_tx_id: &str,
        new_message: hyperlane_core::HyperlaneMessage,
        hub_tx: &H256,
    ) {
        if let Some(db) = &self.kaspa_db {
            let new_message_id = new_message.id();
            info!(
                kaspa_tx = %kaspa_tx_id,
                new_message_id = ?new_message_id,
                hub_tx = ?hub_tx,
                nonce = new_message.nonce,
                "Updating deposit with new message and Hub transaction ID"
            );

            match db.update_processed_deposit(kaspa_tx_id, new_message, hub_tx) {
                Ok(()) => {
                    info!(
                        kaspa_tx = %kaspa_tx_id,
                        new_message_id = ?new_message_id,
                        hub_tx = ?hub_tx,
                        "Successfully updated deposit with new message and Hub transaction ID"
                    );
                }
                Err(e) => {
                    error!(
                        error = ?e,
                        kaspa_tx = %kaspa_tx_id,
                        new_message_id = ?new_message_id,
                        hub_tx = ?hub_tx,
                        "update deposit"
                    );
                }
            }
        } else {
            error!("no database available for updating deposit");
        }
    }

    pub fn consume_pending_confirmation(&self) -> Option<ConfirmationFXG> {
        self.pending_confirmation.consume()
    }

    pub fn has_pending_confirmation(&self) -> bool {
        self.pending_confirmation.has_pending()
    }

    pub async fn get_pending_confirmation(&self) -> Option<ConfirmationFXG> {
        self.pending_confirmation.get_pending()
    }

    pub fn get_min_deposit_sompi(&self) -> U256 {
        self.conf.min_deposit_sompi
    }

    pub fn kas_key_source(&self) -> &crate::conf::KaspaEscrowKeySource {
        self.kas_key_source
            .as_ref()
            .expect("Kaspa key source not configured")
    }

    pub fn rest(&self) -> &RestProvider {
        &self.rest
    }

    async fn rpc(&self) -> Arc<DynRpcApi> {
        let wallet = self.easy_wallet.read().await;
        wallet.api()
    }

    pub fn validators(&self) -> &ValidatorsClient {
        &self.validators
    }

    pub fn hub_rpc(&self) -> &CosmosProvider<ModuleQueryClient> {
        &self.cosmos_rpc
    }

    /// Recreate the WRPC wallet connection
    async fn recreate_wallet_connection(&self) -> Result<()> {
        let new_wallet = get_easy_wallet(
            self.domain.clone(),
            self.conf.kaspa_urls_wrpc[0].clone(),
            self.conf.wallet_secret.clone(),
            self.conf.wallet_dir.clone(),
        )
        .await
        .map_err(|e| eyre::eyre!("recreate wallet connection: {}", e))?;

        let mut wallet = self.easy_wallet.write().await;
        *wallet = new_wallet;

        info!("kaspa: recreated WRPC wallet connection");
        Ok(())
    }

    /// Execute RPC operation with automatic reconnection on error
    async fn rpc_with_reconnect<T, F, Fut>(&self, op: F) -> Result<T>
    where
        F: Fn(Arc<DynRpcApi>) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let rpc = self.rpc().await;
        match op(rpc).await {
            Ok(result) => Ok(result),
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("WebSocket is not connected")
                    || err_str.contains("not connected")
                {
                    if let Err(recreate_err) = self.recreate_wallet_connection().await {
                        error!(recreate_error = %recreate_err, "kaspa: failed to recreate WRPC connection");
                        return Err(e);
                    }

                    let new_rpc = self.rpc().await;
                    op(new_rpc).await
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Clone the wallet under read lock
    async fn clone_wallet(&self) -> dym_kas_core::wallet::EasyKaspaWallet {
        let wallet = self.easy_wallet.read().await;
        wallet.clone()
    }

    pub fn must_validator_stuff(&self) -> &ValidatorStuff {
        self.conf.validator_stuff.as_ref().unwrap()
    }

    pub fn must_relayer_stuff(&self) -> &RelayerStuff {
        self.conf.relayer_stuff.as_ref().unwrap()
    }

    pub fn grpc_client(&self) -> Option<kaspa_grpc_client::GrpcClient> {
        self.grpc_client.clone()
    }

    // Process withdrawals from Hub to Kaspa by building and submitting Kaspa transactions.
    // Returns the subset of messages that were successfully processed.
    pub async fn process_withdrawal_messages(
        &self,
        msgs: Vec<HyperlaneMessage>,
    ) -> Result<Vec<(HyperlaneMessage, String)>> {
        match self.process_withdrawal_messages_inner(msgs.clone()).await {
            Ok(Some(processed)) => {
                let all_processed_msgs: Vec<_> =
                    processed.fxg.messages.iter().flatten().cloned().collect();

                record_withdrawal_batch_metrics(
                    &self.metrics,
                    &all_processed_msgs,
                    WithdrawalStage::Processed,
                );

                if let Some(last_anchor) = processed.fxg.anchors.last() {
                    let current_ts = kaspa_core::time::unix_now();
                    self.metrics.update_last_anchor_point(
                        &last_anchor.transaction_id.to_string(),
                        last_anchor.index as u64,
                        current_ts,
                    );
                }

                self.pending_confirmation
                    .push(ConfirmationFXG::from_msgs_outpoints(
                        processed.fxg.ids(),
                        processed.fxg.anchors.clone(),
                    ));
                info!("kaspa provider: added to progress indication work queue");

                let mut result = Vec::new();
                for (tx_id, msgs) in processed.tx_ids.iter().zip(processed.fxg.messages.iter()) {
                    let kaspa_tx = format!("{}", tx_id);
                    for msg in msgs {
                        result.push((msg.clone(), kaspa_tx.clone()));
                    }
                }

                self.hack_store_withdrawals_kaspa_tx_for_query(&result);

                Ok(result)
            }
            Ok(None) => {
                info!("on new withdrawals decided not to handle withdrawal messages");
                Ok(Vec::new())
            }
            Err(error) => {
                record_withdrawal_batch_metrics(&self.metrics, &msgs, WithdrawalStage::Failed);
                Err(error)
            }
        }
    }

    async fn process_withdrawal_messages_inner(
        &self,
        msgs: Vec<HyperlaneMessage>,
    ) -> Result<Option<ProcessedWithdrawals>> {
        let wallet_clone = self.clone_wallet().await;
        let fxg = match on_new_withdrawals(
            msgs.clone(),
            wallet_clone,
            self.cosmos_rpc.clone(),
            self.escrow(),
            self.get_min_deposit_sompi(),
            self.must_relayer_stuff().tx_fee_multiplier,
            self.must_relayer_stuff().max_sweep_inputs,
            self.must_relayer_stuff().max_sweep_bundle_bytes,
        )
        .await?
        {
            Some(fxg) => fxg,
            None => return Ok(None),
        };

        info!("kaspa provider: constructed withdrawal TXs, got withdrawal FXG, now gathering sigs and signing relayer fee");

        let fxg_arc = std::sync::Arc::new(fxg);
        let bundles_validators = self.validators().get_withdraw_sigs(fxg_arc.clone()).await?;

        let wallet_for_fee = self.clone_wallet().await;
        let finalized = combine_bundles_with_fee(
            bundles_validators,
            fxg_arc.as_ref(),
            self.conf.multisig_threshold_kaspa,
            &self.escrow(),
            &wallet_for_fee,
        )
        .await?;

        let tx_ids = self.submit_txs(finalized.clone()).await?;

        info!("kaspa provider: submitted TXs, now indicating progress on the Hub");

        Ok(Some(ProcessedWithdrawals {
            fxg: fxg_arc,
            tx_ids,
        }))
    }

    async fn submit_txs(&self, txs: Vec<RpcTransaction>) -> Result<Vec<RpcTransactionId>> {
        let mut tx_ids = Vec::new();
        for tx in txs {
            // allow_orphan controls whether TX can be submitted without parent TX being in DAG. Set to false to ensure TX chain integrity
            let allow_orphan = false;
            let tx_clone = tx.clone();
            let tx_id = self
                .rpc_with_reconnect(move |rpc| {
                    let tx = tx_clone.clone();
                    async move {
                        rpc.submit_transaction(tx, allow_orphan)
                            .await
                            .map_err(|e| eyre::eyre!("submit transaction: {}", e))
                    }
                })
                .await?;
            tx_ids.push(tx_id);
        }

        if let Err(e) = self.update_balance_metrics().await {
            tracing::error!(error=?e, "update balance metrics");
        }

        Ok(tx_ids)
    }

    pub async fn update_balance_metrics(&self) -> Result<()> {
        let escrow_addr = self.escrow_address();
        let utxos = self
            .rpc_with_reconnect(move |rpc| {
                let addr = escrow_addr.clone();
                async move {
                    rpc.get_utxos_by_addresses(vec![addr])
                        .await
                        .map_err(|e| eyre::eyre!("get UTXOs for escrow address: {}", e))
                }
            })
            .await?;

        let total_escrow_bal: u64 = utxos.iter().map(|utxo| utxo.utxo_entry.amount).sum();

        self.metrics()
            .update_funds_escrowed(total_escrow_bal as i64);
        self.metrics().update_escrow_utxo_count(utxos.len() as i64);

        // Get change address balance
        let change_addr = self.clone_wallet().await.account().change_address()?;
        let change_utxos = self
            .rpc_with_reconnect(move |rpc| {
                let addr = change_addr.clone();
                async move {
                    rpc.get_utxos_by_addresses(vec![addr])
                        .await
                        .map_err(|e| eyre::eyre!("get UTXOs for change address: {}", e))
                }
            })
            .await?;

        let total_change_bal: u64 = change_utxos.iter().map(|utxo| utxo.utxo_entry.amount).sum();
        self.metrics().update_relayer_funds(total_change_bal as i64);

        Ok(())
    }

    pub fn escrow(&self) -> EscrowPublic {
        self.escrow.clone()
    }

    pub fn escrow_address(&self) -> Address {
        self.escrow().addr
    }

    pub fn metrics(&self) -> &KaspaBridgeMetrics {
        &self.metrics
    }

    /// Get the address prefix from the wallet
    pub async fn address_prefix(&self) -> kaspa_addresses::Prefix {
        self.easy_wallet.read().await.net.address_prefix
    }

    /// Get the wallet network info (cloned)
    pub async fn wallet_net(&self) -> dym_kas_core::wallet::NetworkInfo {
        self.easy_wallet.read().await.net.clone()
    }

    /// Get UTXOs by addresses with automatic reconnection on WebSocket errors
    pub async fn get_utxos_by_addresses(
        &self,
        addresses: Vec<kaspa_addresses::Address>,
    ) -> Result<Vec<kaspa_rpc_core::RpcUtxosByAddressesEntry>> {
        self.rpc_with_reconnect(move |rpc| {
            let addrs = addresses.clone();
            async move {
                rpc.get_utxos_by_addresses(addrs)
                    .await
                    .map_err(|e| eyre::eyre!("get UTXOs by addresses: {}", e))
            }
        })
        .await
    }
}

impl std::fmt::Debug for KaspaProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KaspaProvider")
            .field("domain", &self.domain)
            .field("easy_wallet", &"<RwLock<EasyKaspaWallet>>")
            .field("escrow", &self.escrow)
            .finish()
    }
}

impl HyperlaneChain for KaspaProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

// Only used by scraper, not implemented for Kaspa
#[async_trait]
impl HyperlaneProvider for KaspaProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        Err(HyperlaneProviderError::CouldNotFindBlockByHeight(height).into())
    }

    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        return Err(HyperlaneProviderError::CouldNotFindTransactionByHash(*hash).into());
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        Ok(true)
    }

    async fn get_balance(&self, _address: String) -> ChainResult<U256> {
        Ok(0.into())
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        return Ok(None);
    }
}

async fn get_easy_wallet(
    domain: HyperlaneDomain,
    rpc_url: String,
    wallet_secret: String,
    storage_dir: Option<String>,
) -> Result<EasyKaspaWallet> {
    let args = EasyKaspaWalletArgs {
        wallet_secret,
        wrpc_url: rpc_url,
        net: domain_to_kas_network(&domain),
        storage_folder: storage_dir,
    };
    EasyKaspaWallet::try_new(args).await
}

fn cosmos_grpc_client(urls: Vec<Url>) -> CosmosProvider<ModuleQueryClient> {
    let hub_cfg = HubConnectionConf::new(
        urls.clone(), // grpc_urls
        vec![],       // rpc_urls
        "".to_string(),
        "".to_string(),
        "".to_string(),
        RawCosmosAmount {
            denom: "".to_string(),
            amount: "0".to_string(),
        },
        32,
        OpSubmissionConfig::default(),
        NativeToken::default(),
        1.0,
        None, // compat_mode
    )
    .expect("create Hub connection config with default values");
    let metrics = PrometheusClientMetrics::default();
    let chain = None;
    let dummy_domain = hyperlane_core::HyperlaneDomain::new_test_domain("dummy");
    let loc = hyperlane_core::ContractLocator {
        domain: &dummy_domain,
        address: hyperlane_core::H256::zero(),
    };
    CosmosProvider::<ModuleQueryClient>::new(&hub_cfg, &loc, None, metrics, chain)
        .expect("create CosmosProvider for query client")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cosmos_grpc_client_playground() {
        // Install rustls crypto provider (required for rustls 0.23+)
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

        let url = Url::parse("https://grpc-dymension-playground35.mzonder.com").expect("parse URL");
        let _client = cosmos_grpc_client(vec![url]);
    }
}
