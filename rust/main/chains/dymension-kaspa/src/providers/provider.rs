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

#[derive(Debug, Clone)]
pub struct KaspaProvider {
    conf: ConnectionConf,
    domain: HyperlaneDomain,
    easy_wallet: EasyKaspaWallet,
    rest: RestProvider,
    validators: ValidatorsClient,
    cosmos_rpc: CosmosProvider<ModuleQueryClient>,

    // Kaspa escrow key source (Direct JSON or AWS KMS config)
    kas_key_source: Option<crate::conf::KaspaEscrowKeySource>,

    // Optimistic hint for next confirmation needed on Hub. If out of date, relayer polls Kaspa to sync
    pending_confirmation: Arc<PendingConfirmation>,

    metrics: KaspaBridgeMetrics,
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
        let validators = ValidatorsClient::new(cfg.clone())?;

        let easy_wallet = get_easy_wallet(
            domain.clone(),
            cfg.kaspa_urls_wrpc[0].clone(), // TODO: try all of them as needed
            cfg.wallet_secret.clone(),
            cfg.wallet_dir.clone(),
        )
        .await
        .map_err(|e| eyre::eyre!("Failed to create easy wallet: {}", e))?;

        let kas_key_source = cfg
            .validator_stuff
            .as_ref()
            .map(|v| v.kas_escrow_key_source.clone());

        let kaspa_metrics = if let Some(reg) = registry {
            KaspaBridgeMetrics::new(reg).expect("Failed to create KaspaBridgeMetrics")
        } else {
            KaspaBridgeMetrics::new(&prometheus::default_registry())
                .expect("Failed to create default KaspaBridgeMetrics")
        };

        let provider = KaspaProvider {
            domain: domain.clone(),
            conf: cfg.clone(),
            easy_wallet,
            rest,
            validators,
            cosmos_rpc: cosmos_grpc_client(cfg.hub_grpc_urls.clone()),
            kas_key_source,
            pending_confirmation: Arc::new(PendingConfirmation::new()),
            metrics: kaspa_metrics,
        };

        if let Err(e) = provider.update_balance_metrics().await {
            tracing::error!("Failed to initialize balance metrics on startup: {:?}", e);
        }

        Ok(provider)
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

    pub fn rpc(&self) -> Arc<DynRpcApi> {
        self.easy_wallet.api()
    }

    pub fn validators(&self) -> &ValidatorsClient {
        &self.validators
    }

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

    pub fn kaspa_time_cfg(&self) -> Option<crate::conf::KaspaTimeConfig> {
        self.conf
            .relayer_stuff
            .as_ref()
            .map(|r| r.kaspa_time_config.clone())
    }

    // Process withdrawals from Hub to Kaspa by building and submitting Kaspa transactions.
    // Returns the subset of messages that were successfully processed.
    pub async fn process_withdrawal_messages(
        &self,
        msgs: Vec<HyperlaneMessage>,
    ) -> Result<Vec<HyperlaneMessage>> {
        let min_withdrawal_amt = self.conf.min_deposit_sompi;
        let res = on_new_withdrawals(
            msgs.clone(),
            self.easy_wallet.clone(),
            self.cosmos_rpc.clone(),
            self.escrow(),
            min_withdrawal_amt,
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
                let total_amt = calculate_total_withdrawal_amount(&all_msgs);

                let bundles_validators = match self.validators().get_withdraw_sigs(&fxg).await {
                    Ok(bundles) => bundles,
                    Err(e) => {
                        // Record withdrawal failure with deduplication
                        self.metrics
                            .record_withdrawal_failed(&withdrawal_batch_id, total_amt);
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
                            .record_withdrawal_failed(&withdrawal_batch_id, total_amt);
                        return Err(e);
                    }
                };

                match self.submit_txs(finalized.clone()).await {
                    Ok(_) => {
                        info!("Kaspa provider, submitted TXs, now indicating progress on the Hub");

                        let msg_count =
                            fxg.messages.iter().map(|msgs| msgs.len()).sum::<usize>() as u64;
                        self.metrics.record_withdrawal_processed(
                            &withdrawal_batch_id,
                            total_amt,
                            msg_count,
                        );

                        if let Some(last_anchor) = fxg.anchors.last() {
                            let current_ts = kaspa_core::time::unix_now();
                            self.metrics.update_last_anchor_point(
                                &last_anchor.transaction_id.to_string(),
                                last_anchor.index as u64,
                                current_ts,
                            );
                        }

                        self.pending_confirmation
                            .push(ConfirmationFXG::from_msgs_outpoints(fxg.ids(), fxg.anchors));
                        info!("Kaspa provider, added to progress indication work queue");

                        Ok(all_msgs)
                    }
                    Err(e) => {
                        self.metrics
                            .record_withdrawal_failed(&withdrawal_batch_id, total_amt);
                        Err(e)
                    }
                }
            }
            Ok(None) => {
                info!("On new withdrawals decided not to handle withdrawal messages");
                Ok(msgs)
            }
            Err(e) => {
                let withdrawal_batch_id = create_withdrawal_batch_id(&msgs);
                let failed_amt = calculate_total_withdrawal_amount(&msgs);
                self.metrics
                    .record_withdrawal_failed(&withdrawal_batch_id, failed_amt);
                Err(e)
            }
        }
    }

    async fn submit_txs(&self, txs: Vec<RpcTransaction>) -> Result<Vec<RpcTransactionId>> {
        let mut tx_ids = Vec::new();
        for tx in txs {
            // allow_orphan controls whether TX can be submitted without parent TX being in DAG. Set to false to ensure TX chain integrity
            let allow_orphan = false;
            let tx_id = self
                .easy_wallet
                .api()
                .submit_transaction(tx, allow_orphan)
                .await?;
            tx_ids.push(tx_id);
        }

        if let Err(e) = self.update_balance_metrics().await {
            tracing::error!("Failed to update balance metrics: {:?}", e);
        }

        Ok(tx_ids)
    }

    pub async fn update_balance_metrics(&self) -> Result<()> {
        let utxos = self
            .rpc()
            .get_utxos_by_addresses(vec![self.escrow_address()])
            .await
            .map_err(|e| eyre::eyre!("Failed to get UTXOs for escrow address: {}", e))?;

        let total_escrow_bal: u64 = utxos.iter().map(|utxo| utxo.utxo_entry.amount).sum();

        self.metrics()
            .update_funds_escrowed(total_escrow_bal as i64);
        self.metrics().update_escrow_utxo_count(utxos.len() as i64);

        let acct = self.wallet().account();
        // Wallet balance may not be immediately available, retry a few times
        let mut bal_opt = None;
        for _ in 0..5 {
            if let Some(b) = acct.balance() {
                bal_opt = Some(b);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }

        if let Some(bal) = bal_opt {
            self.metrics().update_relayer_funds(bal.mature as i64);
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

    pub fn escrow_address(&self) -> Address {
        self.escrow().addr
    }

    pub fn metrics(&self) -> &KaspaBridgeMetrics {
        &self.metrics
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
    .unwrap(); // TODO: no unwrap for Result
    let metrics = PrometheusClientMetrics::default();
    let chain = None;
    // Create dummy locator since we only need the query client, not full provider functionality
    let dummy_domain = hyperlane_core::HyperlaneDomain::new_test_domain("dummy");
    let loc = hyperlane_core::ContractLocator {
        domain: &dummy_domain,
        address: hyperlane_core::H256::zero(),
    };
    CosmosProvider::<ModuleQueryClient>::new(&hub_cfg, &loc, None, metrics, chain).unwrap()
    // TODO: no unwrap
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cosmos_grpc_client_playground() {
        // Install rustls crypto provider (required for rustls 0.23+)
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

        let url = Url::parse("https://grpc-dymension-playground35.mzonder.com")
            .expect("Failed to parse URL");
        let _client = cosmos_grpc_client(vec![url]);
    }
}
