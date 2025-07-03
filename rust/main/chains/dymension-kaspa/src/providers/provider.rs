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
use dym_kas_relayer::withdraw::messages::on_new_withdrawals;
use dym_kas_relayer::withdraw::hub_to_kaspa::finalize_pskt;
use dym_kas_relayer::withdraw::hub_to_kaspa::sign_pay_fee;
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

use super::confirmation_queue::ConfirmationQueue;
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

    // Queue stores confirmations that need to be sent on the Hub eventually.
    // It stores two values: prev_outpoint and next_outpoint, respectively.
    // Note that IndicateProgress tx and Outpoint query create a race condition over
    // the last outpoint stored on the Hub.
    queue: Arc<ConfirmationQueue>,
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
            queue: Arc::new(ConfirmationQueue::new()),
        })
    }

    /// dococo
    pub fn consume_confirmation_queue(&self) -> Vec<ConfirmationFXG> {
        self.queue.consume()
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

    /// dococo
    pub async fn construct_withdrawal(
        &self,
        msgs: Vec<HyperlaneMessage>,
    ) -> Result<Option<(WithdrawFXG, TransactionOutpoint)>> {
        on_new_withdrawals(
            msgs,
            self.easy_wallet.clone(),
            self.cosmos_rpc.clone(),
            self.escrow(),
            None,
        )
        .await
    }

    /// dococo
    /// Returns next outpoint
    pub async fn process_withdrawal(
        &self,
        fxg: WithdrawFXG,
        prev_outpoint: TransactionOutpoint,
    ) -> Result<()> {
        info!("Kaspa provider, got withdrawal FXG, now gathering sigs and signing relayer fee");
        let all_bundles = {
            let mut bundles_validators = self.validators().get_withdraw_sigs(&fxg).await?;
            info!("Kaspa provider, got validator bundles, now signing relayer fee");
            if bundles_validators.len() < self.conf.multisig_threshold_kaspa as usize {
                return Err(eyre!(
                    "Not enough validator bundles, required: {}, got: {}",
                    self.conf.multisig_threshold_kaspa,
                    bundles_validators.len()
                ));
            }

            let bundle_relayer = self.sign_relayer_fee(&fxg).await?; // TODO: can add own sig in parallel to validator network request
            info!("Kaspa provider, got relayer fee bundle, now combining all bundles");
            bundles_validators.push(bundle_relayer);
            bundles_validators
        };
        let txs_signed = combine_all_bundles(all_bundles)?;
        let finalized = finalize_txs(txs_signed, fxg.messages.clone(), self.escrow().pubs.clone())?;
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

        self.queue.push(ConfirmationFXG::from_msgs_outpoints(
            fxg.ids(),
            vec![
                prev_outpoint.clone(),
                // TODO: it also needs to include any outpoints in-between
                next_outpoint.clone(),
            ],
        ));
        info!("Kaspa provider, added to progress indication work queue");

        Ok(())
    }

    async fn sign_relayer_fee(&self, fxg: &WithdrawFXG) -> Result<Bundle> {
        // returns bundle of Signer
        let wallet = self.easy_wallet.wallet.clone();
        let secret = self.easy_wallet.secret.clone();

        let mut signed = Vec::new();
        // Iterate over (PSKT; associated HL messages) pairs
        for (pskt, messages) in fxg.bundle.iter().zip(fxg.messages.clone().into_iter()) {
            let pskt = PSKT::<Signer>::from(pskt.clone());

            let payload_msg_ids = MessageIDs::from(messages)
                .to_bytes()
                .map_err(|e| eyre::eyre!("Deserialize MessageIDs: {}", e))?;

            signed.push(sign_pay_fee(pskt, &wallet, &secret, payload_msg_ids).await?);
        }
        Ok(Bundle::from(signed))
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

    fn escrow(&self) -> EscrowPublic {
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

/// accepts bundle of signer
fn combine_all_bundles(bundles: Vec<Bundle>) -> EyreResult<Vec<PSKT<Combiner>>> {
    // each bundle is from a different actor (validator or releayer), and is a vector of pskt
    // therefore index i of each vector corresponds to the same TX i

    // make a list of lists, each top level element is a vector of pskt from a different actor
    let actor_pskts = bundles
        .iter()
        .map(|b| {
            b.iter()
                .map(|inner| PSKT::<Signer>::from(inner.clone()))
                .collect::<Vec<PSKT<Signer>>>()
        })
        .collect::<Vec<Vec<PSKT<Signer>>>>();

    let n_txs = actor_pskts.first().unwrap().len();

    // need to walk across each tx, and for each tx walk across each actor, and combine all for that tx, so all the sigs
    // for each tx are grouped together in one vector
    let mut tx_sigs: Vec<Vec<PSKT<Signer>>> = Vec::new();
    for tx_i in 0..n_txs {
        let mut all_sigs_for_tx = Vec::new();
        for tx_sigs_from_actor_j in actor_pskts.iter() {
            all_sigs_for_tx.push(tx_sigs_from_actor_j[tx_i].clone());
        }
        tx_sigs.push(all_sigs_for_tx);
    }

    // walk across each tx and combine all the sigs for that tx into one combiner
    let mut ret = Vec::new();
    for all_actor_sigs_for_tx in tx_sigs.iter() {
        let mut combiner = all_actor_sigs_for_tx.first().unwrap().clone().combiner();
        for tx_sig in all_actor_sigs_for_tx.iter().skip(1) {
            combiner = (combiner + tx_sig.clone())?;
        }
        ret.push(combiner);
    }
    Ok(ret)
}

fn finalize_txs(
    txs_sigs: Vec<PSKT<Combiner>>,
    messages: Vec<Vec<HyperlaneMessage>>,
    escrow_pubs: Vec<PublicKey>,
) -> Result<Vec<RpcTransaction>> {
    let transactions_result: Result<Vec<RpcTransaction>, _> = txs_sigs
        .into_iter()
        .zip(messages.into_iter())
        .map(|(tx, messages)| {
            let msg_ids_bytes = MessageIDs::from(messages)
                .to_bytes()
                .map_err(|e| format!("Deserialize MessageIDs: {}", e))?;
            finalize_pskt(tx, msg_ids_bytes, escrow_pubs.clone())
        })
        .collect();

    let transactions: Vec<RpcTransaction> = transactions_result?;

    Ok(transactions)
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
