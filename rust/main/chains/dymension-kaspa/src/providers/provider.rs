use super::confirmation_queue::PendingConfirmation;
use super::validators::ValidatorsClient;
use super::RestProvider;
use crate::util::domain_to_kas_network;
use crate::ConnectionConf;
use crate::RelayerStuff;
use crate::ValidatorStuff;
use dym_kas_core::confirmation::ConfirmationFXG;
use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::message::{calculate_total_withdrawal_amount, create_withdrawal_batch_id};
use dym_kas_core::wallet::{EasyKaspaWallet, EasyKaspaWalletArgs};
use dym_kas_relayer::withdraw::hub_to_kaspa::combine_bundles_with_fee;
use dym_kas_relayer::withdraw::messages::on_new_withdrawals;
use dym_kas_relayer::KaspaBridgeMetrics;
pub use dym_kas_validator::KaspaSecpKeypair;
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
use kaspa_wallet_core::prelude::DynRpcApi;
use prometheus::Registry;
use std::sync::Arc;
use tonic::async_trait;
use tracing::info;
use url::Url;

/// dococo
#[derive(Debug, Clone)]
pub struct KaspaProvider {
    conf: ConnectionConf,
    domain: HyperlaneDomain,
    easy_wallet: EasyKaspaWallet,
    rest: RestProvider,
    validators: ValidatorsClient,
    cosmos_rpc: CosmosProvider<ModuleQueryClient>,

    /*
      TODO: this is just a quick hack to get access to a kaspa escrow private key, we should change to wallet managed
    */
    kas_key: Option<KaspaSecpKeypair>,

    /// Optimistically give a hint for the next confirmation needed to be done on the Hub
    /// If this value is out of date, the relayer can still manually poll Kaspa to figure out how to get synced
    pending_confirmation: Arc<PendingConfirmation>,

    /// Kaspa bridge metrics for monitoring deposits, withdrawals, and failures
    metrics: KaspaBridgeMetrics,
}

impl KaspaProvider {
    /// dococo
    pub async fn new(
        conf: &ConnectionConf,
        domain: HyperlaneDomain,
        signer: Option<HyperlaneSigner>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
        registry: Option<&Registry>,
    ) -> ChainResult<Self> {
        let rest = RestProvider::new(conf.clone(), signer, metrics.clone(), chain.clone())?;
        let validators = ValidatorsClient::new(conf.clone())?;

        let easy_wallet = get_easy_wallet(
            domain.clone(),
            conf.kaspa_urls_wrpc[0].clone(), // TODO: try all of them as needed
            conf.wallet_secret.clone(),
            conf.wallet_dir.clone(),
        )
        .await
        .map_err(|e| eyre::eyre!("Failed to create easy wallet: {}", e))?;

        let kas_key = match &conf.validator_stuff {
            Some(v) => {
                let kp: KaspaSecpKeypair = serde_json::from_str(&v.kas_escrow_private).unwrap();
                Some(kp)
            }
            None => None,
        };

        let kaspa_metrics = if let Some(reg) = registry {
            KaspaBridgeMetrics::new(reg).expect("Failed to create KaspaBridgeMetrics")
        } else {
            // Use default registry as fallback
            KaspaBridgeMetrics::new(&prometheus::default_registry())
                .expect("Failed to create default KaspaBridgeMetrics")
        };

        let provider = KaspaProvider {
            domain: domain.clone(),
            conf: conf.clone(),
            easy_wallet,
            rest,
            validators,
            cosmos_rpc: cosmos_grpc_client(conf.hub_grpc_urls.clone()),
            kas_key,
            pending_confirmation: Arc::new(PendingConfirmation::new()),
            metrics: kaspa_metrics,
        };

        // Initialize balance metrics on startup
        if let Err(e) = provider.update_balance_metrics().await {
            tracing::warn!("Failed to initialize balance metrics on startup: {:?}", e);
        }

        Ok(provider)
    }

    /// dococo
    pub fn consume_pending_confirmation(&self) -> Option<ConfirmationFXG> {
        self.pending_confirmation.consume()
    }

    pub fn has_pending_confirmation(&self) -> bool {
        self.pending_confirmation.has_pending()
    }

    pub async fn get_pending_confirmation(&self) -> Option<ConfirmationFXG> {
        self.pending_confirmation.get_pending()
    }

    /// Get the minimum deposit amount in sompi from configuration
    pub fn get_min_deposit_sompi(&self) -> U256 {
        self.conf.min_deposit_sompi
    }

    /// dococo
    pub fn must_kas_key(&self) -> KaspaSecpKeypair {
        self.kas_key.unwrap()
    }

    /// dococo
    pub fn rest(&self) -> &RestProvider {
        &self.rest
    }

    /// dococo
    pub fn rpc(&self) -> Arc<DynRpcApi> {
        self.easy_wallet.api()
    }

    /// dococo
    pub fn validators(&self) -> &ValidatorsClient {
        &self.validators
    }

    /// dococo
    pub fn hub_rpc(&self) -> &CosmosProvider<ModuleQueryClient> {
        &self.cosmos_rpc
    }

    pub fn wallet(&self) -> &EasyKaspaWallet {
        &self.easy_wallet
    }

    pub fn must_validator_stuff(&self) -> &ValidatorStuff {
        self.conf.validator_stuff.as_ref().unwrap()
    }

    pub fn must_relayer_stuff(&self) -> &RelayerStuff {
        self.conf.relayer_stuff.as_ref().unwrap()
    }

    /// Get the Kaspa deposit configuration if available
    pub fn kaspa_time_config(&self) -> Option<crate::conf::KaspaTimeConfig> {
        self.conf
            .relayer_stuff
            .as_ref()
            .map(|r| r.kaspa_time_config.clone())
    }

    /// dococo
    /// Returns next outpoint
    pub async fn process_withdrawal_messages(
        &self,
        msgs: Vec<HyperlaneMessage>,
    ) -> Result<Vec<HyperlaneMessage>> {
        let res = on_new_withdrawals(
            msgs.clone(),
            self.easy_wallet.clone(),
            self.cosmos_rpc.clone(),
            self.escrow(),
            self.conf.min_deposit_sompi,
            self.must_relayer_stuff().tx_fee_multiplier,
        )
        .await;

        match res {
            Ok(Some(fxg)) => {
                info!("Kaspa provider, constructed withdrawal TXs");
                info!("Kaspa provider, got withdrawal FXG, now gathering sigs and signing relayer fee");

                // Create withdrawal batch ID and calculate total amount
                let all_msgs: Vec<_> = fxg.messages.iter().flatten().cloned().collect();
                let withdrawal_batch_id = create_withdrawal_batch_id(&all_msgs);
                let total_amount = calculate_total_withdrawal_amount(&all_msgs);

                let bundles_validators = match self.validators().get_withdraw_sigs(&fxg).await {
                    Ok(bundles) => bundles,
                    Err(e) => {
                        // Record withdrawal failure with deduplication
                        self.metrics
                            .record_withdrawal_failed(&withdrawal_batch_id, total_amount);
                        return Err(e.into());
                    }
                };

                let finalized = match combine_bundles_with_fee(
                    bundles_validators,
                    &fxg,
                    self.conf.multisig_threshold_kaspa,
                    &self.escrow(),
                    &self.easy_wallet,
                )
                .await
                {
                    Ok(fin) => fin,
                    Err(e) => {
                        // Record withdrawal failure with deduplication
                        self.metrics
                            .record_withdrawal_failed(&withdrawal_batch_id, total_amount);
                        return Err(e);
                    }
                };

                match self.submit_txs(finalized.clone()).await {
                    Ok(_) => {
                        info!("Kaspa provider, submitted TXs, now indicating progress on the Hub");

                        // Record successful withdrawal with message count
                        let message_count =
                            fxg.messages.iter().map(|msgs| msgs.len()).sum::<usize>() as u64;
                        self.metrics.record_withdrawal_processed(
                            &withdrawal_batch_id,
                            total_amount,
                            message_count,
                        );

                        // Update last withdrawal anchor point metric
                        if let Some(last_anchor) = fxg.anchors.last() {
                            let current_timestamp = kaspa_core::time::unix_now();
                            self.metrics.update_last_anchor_point(
                                &last_anchor.transaction_id.to_string(),
                                last_anchor.index as u64,
                                current_timestamp,
                            );
                        }

                        self.pending_confirmation
                            .push(ConfirmationFXG::from_msgs_outpoints(fxg.ids(), fxg.anchors));
                        info!("Kaspa provider, added to progress indication work queue");

                        Ok(all_msgs)
                    }
                    Err(e) => {
                        // Record withdrawal failure with deduplication
                        self.metrics
                            .record_withdrawal_failed(&withdrawal_batch_id, total_amount);
                        Err(e)
                    }
                }
            }
            Ok(None) => {
                info!("On new withdrawals decided not to handle withdrawal messages");
                Ok(msgs)
            }
            Err(e) => {
                // Create withdrawal batch ID and calculate failed amount
                let withdrawal_batch_id = create_withdrawal_batch_id(&msgs);
                let failed_amount = calculate_total_withdrawal_amount(&msgs);
                self.metrics
                    .record_withdrawal_failed(&withdrawal_batch_id, failed_amount);
                Err(e)
            }
        }
    }

    async fn submit_txs(&self, txs: Vec<RpcTransaction>) -> Result<Vec<RpcTransactionId>> {
        let mut ret = Vec::new();
        for tx in txs {
            let allow_orphan = false; // TODO: what is this?
            let tx_id = self
                .easy_wallet
                .api()
                .submit_transaction(tx, allow_orphan)
                .await?;
            ret.push(tx_id);
        }

        // Update balance metrics after successful transaction submission
        if let Err(e) = self.update_balance_metrics().await {
            tracing::error!("Failed to update balance metrics: {:?}", e);
        }

        Ok(ret)
    }

    /// Update balance metrics for relayer funds and escrow balance
    pub async fn update_balance_metrics(&self) -> Result<()> {
        // Get UTXOs for escrow address using RPC API
        let utxos = self
            .rpc()
            .get_utxos_by_addresses(vec![self.escrow_address()])
            .await
            .map_err(|e| eyre::eyre!("Failed to get UTXOs for escrow address: {}", e))?;

        // Calculate total escrow balance from UTXOs
        let total_escrow_balance: u64 = utxos.iter().map(|utxo| utxo.utxo_entry.amount).sum();

        // Update metrics
        self.metrics()
            .update_funds_escrowed(total_escrow_balance as i64);
        self.metrics().update_escrow_utxo_count(utxos.len() as i64);

        // Also update relayer balance if we have a wallet account
        let account = self.wallet().account();
        // Try to get balance with a few retries
        let mut balance_opt = None;
        for _ in 0..5 {
            if let Some(b) = account.balance() {
                balance_opt = Some(b);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }

        if let Some(balance) = balance_opt {
            // Use mature balance for relayer funds metric
            self.metrics().update_relayer_funds(balance.mature as i64);
        }

        Ok(())
    }

    pub fn escrow(&self) -> EscrowPublic {
        EscrowPublic::from_strs(
            self.conf.validator_pub_keys.clone(),
            self.easy_wallet.net.address_prefix,
            self.conf.multisig_threshold_kaspa as u8,
        )
    }

    /// get escrow address
    pub fn escrow_address(&self) -> Address {
        self.escrow().addr
    }

    /// Get access to Kaspa bridge metrics
    pub fn metrics(&self) -> &KaspaBridgeMetrics {
        &self.metrics
    }
}

impl HyperlaneChain for KaspaProvider {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for KaspaProvider {
    // only used by scraper
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        Err(HyperlaneProviderError::CouldNotFindBlockByHeight(height).into())
    }

    // only used by scraper
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        return Err(HyperlaneProviderError::CouldNotFindTransactionByHash(*hash).into());
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // TODO: check if the address is a recipient (this is a hyperlane team todo)
        return Ok(true);
    }

    async fn get_balance(&self, _address: String) -> ChainResult<U256> {
        // TODO: maybe I can return just a larger number here?
        return Ok(0.into());
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        return Ok(None);
    }
}

async fn get_easy_wallet(
    domain: HyperlaneDomain,
    rpc_url: String,
    wallet_secret: String,
    storage_folder: Option<String>,
) -> Result<EasyKaspaWallet> {
    let args = EasyKaspaWalletArgs {
        wallet_secret,
        wrpc_url: rpc_url,
        net: domain_to_kas_network(&domain),
        storage_folder,
    };
    EasyKaspaWallet::try_new(args).await
}

fn cosmos_grpc_client(urls: Vec<Url>) -> CosmosProvider<ModuleQueryClient> {
    let hub_conf = HubConnectionConf::new(
        urls.clone(), // grpc_urls
        vec![],       // rpc_urls
        "".to_string(),
        "".to_string(),
        "".to_string(),
        RawCosmosAmount {
            denom: "".to_string(),
            amount: "".to_string(),
        },
        32,
        OpSubmissionConfig::default(),
        NativeToken::default(),
        1.0,
        None, // compat_mode
    )
    .unwrap(); // TODO: no unwrap for Result
    let metrics = PrometheusClientMetrics::default();
    let chain = None;
    // Create a dummy locator since we only need the query client
    let dummy_domain = hyperlane_core::HyperlaneDomain::new_test_domain("dummy");
    let locator = hyperlane_core::ContractLocator {
        domain: &dummy_domain,
        address: hyperlane_core::H256::zero(),
    };
    CosmosProvider::<ModuleQueryClient>::new(&hub_conf, &locator, None, metrics, chain).unwrap()
    // TODO: no unwrap
}
