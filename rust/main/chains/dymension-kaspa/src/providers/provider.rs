use dym_kas_core::wallet::{EasyKaspaWallet, EasyKaspaWalletArgs, Network};
use dym_kas_relayer::PublicKey;

use core::default;
use eyre::Result as EyreResult;
use kaspa_addresses::Address;
use futures::stream::{self, StreamExt, TryStreamExt};
use kaspa_rpc_core::model::{RpcTransaction, RpcTransactionId};
use kaspa_wallet_pskt::prelude::*;
use std::any::Any;
use std::str::FromStr;
use tonic::async_trait;
use url::Url;

use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::withdraw::WithdrawFXG;
use dym_kas_relayer::withdraw::{finalize_pskt, sign_pay_fee};
use dym_kas_relayer::withdraw_construction::on_new_withdrawals;
pub use dym_kas_validator::KaspaSecpKeypair;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, ContractLocator, HyperlaneChain, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, HyperlaneProviderError, KnownHyperlaneDomain, TxnInfo,
    H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
use kaspa_consensus_core::tx::Transaction;
use kaspa_wallet_pskt::prelude::Bundle;
use kaspa_rpc_core::api::rpc::RpcApi;
use std::sync::Arc;


use super::validators::ValidatorsClient;
use super::RestProvider;

use crate::ConnectionConf;
use eyre::Result;

use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::NativeToken;
use hyperlane_cosmos_native::ConnectionConf as HubConnectionConf;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_native::RawCosmosAmount;
use hyperlane_cosmos_native::Signer as HyperlaneSigner;

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
            .map(|k| KaspaSecpKeypair::from_str(k).unwrap());

        Ok(KaspaProvider {
            domain: domain.clone(),
            conf: conf.clone(),
            easy_wallet,
            rest,
            validators,
            cosmos_rpc: cosmos_grpc_client(conf.hub_grpc_urls.clone()),
            kas_key,
        })
    }

    pub fn must_kas_key(&self) -> KaspaSecpKeypair {
        self.kas_key.unwrap()
    }

    /// dococo
    pub fn rest(&self) -> &RestProvider {
        &self.rest
    }

    /// dococo
    pub fn rpc(&self) -> Arc<dyn RpcApi> {
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

    /// dococo
    pub async fn construct_withdrawal(
        &self,
        msgs: Vec<HyperlaneMessage>,
    ) -> Result<Option<WithdrawFXG>> {
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
    pub async fn process_withdrawal(&self, fxg: &WithdrawFXG) -> Result<()> {
        let all_bundles = {
            let mut bundles_validators = self.validators().get_withdraw_sigs(fxg).await?;
            let bundle_relayer = self.sign_relayer_fee(fxg).await?; // TODO: can add own sig in parallel to validator network request
            bundles_validators.push(bundle_relayer);
            bundles_validators
        };
        let txs_signed = combine_all_bundles(all_bundles)?;
        let finalized = finalize_txs(txs_signed, self.escrow().pubs.clone())?;
        let res = self.submit_txs(finalized).await?;
        Ok(())
    }

    async fn sign_relayer_fee(&self, fxg: &WithdrawFXG) -> Result<Bundle> {
        // returns bundle of Signer
        let mut signed = Vec::new();
        for pskt in fxg.bundle.iter() {
            let pskt = PSKT::<Signer>::from(pskt.clone());
            let wallet = self.easy_wallet.wallet.clone();
            let secret = self.easy_wallet.secret.clone();
            signed.push(sign_pay_fee(pskt, &wallet, &secret).await?);
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
            self.conf.validator_pks.clone(),
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
            combiner = (combiner + tx_sig.clone()).unwrap();
        }
        ret.push(combiner);
    }
    Ok(ret)
}

fn finalize_txs(
    txs_sigs: Vec<PSKT<Combiner>>,
    escrow_pubs: Vec<PublicKey>,
) -> Result<Vec<RpcTransaction>> {
    let transactions_result: Result<Vec<RpcTransaction>, _> = txs_sigs
        .iter()
        /*
        TODO: finalize_pskt has some hacky assumptions on the order of inputs, which needs to be reconciled which was only for demo
        but we need to generalise to make it work for the real construction https://github.com/dymensionxyz/hyperlane-monorepo/blob/1bc3abb42e9cb0b67146b89afa9fe97eea267126/dymension/libs/kaspa/lib/relayer/src/withdraw.rs#L136
        */
        .map(|tx| finalize_pskt(tx.clone(), escrow_pubs.clone())) // TODO: avoid clones
        .collect();

    let transactions: Vec<RpcTransaction> = transactions_result.map_err(|e| eyre::eyre!(e))?;

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
