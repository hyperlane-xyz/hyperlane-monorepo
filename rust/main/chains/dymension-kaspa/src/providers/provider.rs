use dym_kas_core::wallet::{EasyKaspaWallet, EasyKaspaWalletArgs, Network};
use dym_kas_relayer::PublicKey;

use eyre::{eyre, Result as EyreResult};
use kaspa_addresses::Address;
use kaspa_rpc_core::model::{RpcTransaction, RpcTransactionId};
use kaspa_wallet_core::prelude::DynRpcApi;
use kaspa_wallet_pskt::prelude::*;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use tonic::async_trait;
use tracing::warn;
use url::Url;

use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::withdraw::WithdrawFXG;
use dym_kas_relayer::withdraw::hub_to_kaspa::combine_bundles_with_fee;
use dym_kas_relayer::withdraw::messages::on_new_withdrawals;
pub use dym_kas_validator::KaspaSecpKeypair;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, HyperlaneProviderError, KnownHyperlaneDomain, TxnInfo, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_wallet_pskt::prelude::Bundle;
use serde::{Deserialize, Serialize};
use tracing::info;

use super::confirmation_queue::PendingConfirmation;
use super::validators::ValidatorsClient;
use super::RestProvider;
use dym_kas_core::confirmation::ConfirmationFXG;

use crate::ConnectionConf;
use dym_kas_core::payload::MessageIDs;
use eyre::Result;
use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::NativeToken;
use hyperlane_cosmos_native::ConnectionConf as HubConnectionConf;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_native::RawCosmosAmount;
use hyperlane_cosmos_native::Signer as HyperlaneSigner;
use kaspa_consensus_core::tx::TransactionOutpoint;

/// dococo
#[derive(Debug, Clone)]
pub struct KaspaProvider {
    conf: ConnectionConf,
    domain: HyperlaneDomain,
    easy_wallet: EasyKaspaWallet,
    rest: RestProvider,
    validators: ValidatorsClient,
    cosmos_rpc: CosmosGrpcClient,

    /*
      TODO: this is just a quick hack to get access to a kaspa escrow private key, we should change to wallet managed
    */
    kas_key: Option<KaspaSecpKeypair>,

    /// Optimistically give a hint for the next confirmation needed to be done on the Hub
    /// If this value is out of date, the relayer can still manually poll Kaspa to figure out how to get synced
    pending_confirmation: Arc<PendingConfirmation>,
}

impl KaspaProvider {
    /// dococo
    pub async fn new(
        conf: &ConnectionConf,
        domain: HyperlaneDomain,
        signer: Option<HyperlaneSigner>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let rest = RestProvider::new(conf.clone(), signer, metrics.clone(), chain.clone())?;
        let validators = ValidatorsClient::new(conf.clone())?;

        let easy_wallet = get_easy_wallet(
            domain.clone(),
            conf.kaspa_rpc_url.clone(),
            conf.wallet_secret.clone(),
        )
        .await?;

        let kas_key = conf
            .kaspa_escrow_private_key
            .as_ref()
            .map(|k| serde_json::from_str(k).unwrap());

        Ok(KaspaProvider {
            domain: domain.clone(),
            conf: conf.clone(),
            easy_wallet,
            rest,
            validators,
            cosmos_rpc: cosmos_grpc_client(conf.hub_grpc_urls.clone()),
            kas_key,
            pending_confirmation: Arc::new(PendingConfirmation::new()),
        })
    }

    /// dococo
    pub fn consume_pending_confirmation(&self) -> Option<ConfirmationFXG> {
        self.pending_confirmation.consume()
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
    pub fn hub_rpc(&self) -> &CosmosGrpcClient {
        &self.cosmos_rpc
    }

    pub fn wallet(&self) -> &EasyKaspaWallet {
        &self.easy_wallet
    }

    pub fn hub_mailbox_id(&self) -> String {
        self.conf.hub_mailbox_id.clone()
    }

    /// dococo
    /// Returns next outpoint
    pub async fn process_withdrawal_messages(&self, msgs: Vec<HyperlaneMessage>) -> Result<()> {
        let res = on_new_withdrawals(
            msgs,
            self.easy_wallet.clone(),
            self.cosmos_rpc.clone(),
            self.escrow(),
            None,
        )
        .await?;
        info!("Kaspa provider, constructed withdrawal TXs");

        if res.is_none() {
            info!("On new withdrawals decided not to handle withdrawal messages");
            return Ok(());
        }

        let (fxg, prev_outpoint) = res.unwrap();

        info!("Kaspa provider, got withdrawal FXG, now gathering sigs and signing relayer fee");
        let bundles_validators = self.validators().get_withdraw_sigs(&fxg).await?;

        let finalized = combine_bundles_with_fee(
            bundles_validators,
            &fxg,
            self.conf.multisig_threshold_kaspa as usize,
            &self.escrow(),
            &self.easy_wallet,
        )
        .await?;

        let res_tx_ids = self.submit_txs(finalized.clone()).await?;
        info!("Kaspa provider, submitted TXs, now indicating progress on the Hub");

        // to indicate progress on the Hub, we need to know:
        // - the first outpoint preceding the withdrawal and
        // - the last outpoint of the withdrawal batch

        // assumption: all transaction details live on respective vector indices,
        // i.e. len(txs_signed) == len(finalized) == len(res_tx_ids)
        // and index IDX corresponds to the same transaction in each vector.
        let last_idx = finalized.len() - 1;

        let last_tx = finalized.get(last_idx).unwrap();

        // find the index of anchor.
        // its recipient must be the escrow address.
        let output_idx = last_tx
            .outputs
            .iter()
            .position(|o| o.script_public_key == self.escrow().p2sh.clone().into())
            .unwrap_or_else(|| 0);

        let tx_id = res_tx_ids.get(last_idx).unwrap();

        let next_outpoint = TransactionOutpoint {
            transaction_id: (*tx_id).into(),
            index: (output_idx as u32).into(),
        };

        self.pending_confirmation
            .push(ConfirmationFXG::from_msgs_outpoints(
                fxg.ids().clone(),
                vec![
                    prev_outpoint.clone(),
                    // TODO: it also needs to include any outpoints in-between
                    next_outpoint.clone(),
                ],
            ));
        info!("Kaspa provider, added to progress indication work queue");

        Ok(())
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
        Ok(ret)
    }

    pub fn escrow(&self) -> EscrowPublic {
        EscrowPublic::from_strs(
            self.conf.validator_pub_keys.clone(),
            self.easy_wallet.address_prefix(),
            self.conf.multisig_threshold_kaspa as u8,
        )
    }

    /// get escrow address
    pub fn escrow_address(&self) -> Address {
        self.escrow().addr
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

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
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
) -> Result<EasyKaspaWallet> {
    let args = EasyKaspaWalletArgs {
        wallet_secret,
        rpc_url,
        network: match domain {
            HyperlaneDomain::Known(KnownHyperlaneDomain::KaspaTest10) => Network::KaspaTest10,
            _ => todo!("only tn10 supported"),
        },
    };
    EasyKaspaWallet::try_new(args).await
}

fn cosmos_grpc_client(urls: Vec<Url>) -> CosmosGrpcClient {
    let hub_conf = HubConnectionConf::new(
        vec![],
        urls, // ONLY URLS IS NEEDED
        "".to_string(),
        "".to_string(),
        "".to_string(),
        RawCosmosAmount {
            denom: "".to_string(),
            amount: "".to_string(),
        },
        1.0,
        32,
        OpSubmissionConfig::default(),
        NativeToken::default(),
    );
    let metrics = PrometheusClientMetrics::default();
    let chain = None;
    CosmosGrpcClient::new(hub_conf, metrics, chain).unwrap() // TODO: no unwrap
}
