use dym_kas_core::wallet::{EasyKaspaWallet, EasyKaspaWalletArgs, Network};

use eyre::Result as EyreResult;
use kaspa_wallet_pskt::prelude::*;
use std::any::Any;
use tonic::async_trait;

use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::withdraw::WithdrawFXG;
use dym_kas_relayer::withdraw_construction::on_new_withdrawals;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, ContractLocator, HyperlaneChain, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, HyperlaneProviderError, KnownHyperlaneDomain, TxnInfo,
    H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
use kaspa_consensus_core::tx::Transaction;
use kaspa_wallet_pskt::prelude::Bundle;

use super::validators::ValidatorsClient;
use super::RestProvider;

use crate::ConnectionConf;
use eyre::Result;

use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_native::Signer as HyperlaneSigner;

/// dococo
#[derive(Debug, Clone)]
pub struct KaspaProvider {
    conf: ConnectionConf,
    domain: HyperlaneDomain,
    easy_wallet: EasyKaspaWallet,
    rest: RestProvider,
    validators: ValidatorsClient,
    cosmos_rpc: Option<CosmosGrpcClient>, // WARNING: NOT SET ON INIT
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

        Ok(KaspaProvider {
            domain: domain.clone(),
            conf: conf.clone(),
            easy_wallet,
            rest,
            validators,
            cosmos_rpc: None,
        })
    }

    /// dococo
    pub fn set_cosmos_rpc(&mut self, cosmos_rpc: CosmosGrpcClient) {
        self.cosmos_rpc = Some(cosmos_rpc);
    }

    /// dococo
    pub fn rest(&self) -> &RestProvider {
        &self.rest
    }

    /// dococo
    pub fn validators(&self) -> &ValidatorsClient {
        &self.validators
    }

    /// dococo
    pub async fn construct_withdrawal(
        &self,
        msgs: Vec<HyperlaneMessage>,
    ) -> Result<Option<WithdrawFXG>> {
        on_new_withdrawals(msgs, self.easy_wallet.clone(), self.cosmos_rpc.clone().unwrap(), self.escrow()).await
    }

    /// dococo
    pub async fn process_withdrawal(&self, fxg: &WithdrawFXG) -> Result<()> {
        let bundle_relayer = self.sign_relayer_fee(fxg).await?; // TODO: can add own sig in parallel to validator network request
        let bundles_validators = self.validators().get_withdraw_sigs(fxg).await?;
        let txs_sigs = combine_all_bundles(bundles_validators)?;
        let finalized = finalize_txs(txs_sigs)?;
        let res = self.submit_txs(finalized).await?;
        Ok(())
    }

    async fn sign_relayer_fee(&self, fxg: &WithdrawFXG) -> Result<Bundle> {
        todo!()
    }

    async fn submit_txs(&self, txs: Vec<Transaction>) -> Result<()> {
        todo!()
    }

    fn escrow(&self) -> EscrowPublic {
        EscrowPublic::from_strs(
            self.conf.validator_pks.clone(),
            self.easy_wallet.address_prefix(),
            self.conf.multisig_threshold_kaspa as u8,
        )
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

fn combine_all_bundles(bundles: Vec<Bundle>) -> EyreResult<Vec<PSKT<Combiner>>> {
    // each bundle is from a different validator, and is a vector of pskt
    // therefore index i of each vector corresponds to the same TX i

    let validators = bundles
        .iter()
        .map(|b| {
            b.iter()
                .map(|inner| PSKT::<Signer>::from(inner.clone()))
                .collect::<Vec<PSKT<Signer>>>()
        })
        .collect::<Vec<Vec<PSKT<Signer>>>>();

    let n_txs = validators.first().unwrap().len();

    // need to walk across each tx, and for each tx walk across each signer, and combine all for that tx
    let mut tx_sigs: Vec<Vec<PSKT<Signer>>> = Vec::new();
    for tx_i in 0..n_txs {
        let mut all_sigs_for_tx = Vec::new();
        for tx_sigs_from_val_j in validators.iter() {
            all_sigs_for_tx.push(tx_sigs_from_val_j[tx_i].clone());
        }
        tx_sigs.push(all_sigs_for_tx);
    }

    let mut ret = Vec::new();
    for all_val_sigs_for_tx in tx_sigs.iter() {
        let mut combiner = all_val_sigs_for_tx.first().unwrap().clone().combiner();
        for tx_sig in all_val_sigs_for_tx.iter().skip(1) {
            combiner = (combiner + tx_sig.clone()).unwrap();
        }
        ret.push(combiner);
    }
    Ok(ret)
}

fn finalize_txs(txs_sigs: Vec<PSKT<Combiner>>) -> Result<Vec<Transaction>> {
    todo!()
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
