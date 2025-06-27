use std::str::FromStr;

use derive_new::new;
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, FixedPointNumber, NativeToken, H256,
};

/// Kaspa connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    pub wallet_secret: String,
    pub kaspa_rpc_url: String, // direct connection to kaspa DAG node .e.g localhost:16210
    pub kaspa_rest_url: Url, // connection to Kaspa higher level indexer server e.g. https://api.kaspa.org
    pub validator_ids: Vec<H256>, // TODO: needed? // https://github.com/dymensionxyz/hyperlane-monorepo/blob/fe1c79156f5ef6ead5bc60f26a373d0867848532/rust/main/hyperlane-base/src/types/multisig.rs#L169
    pub validator_hosts: Vec<String>,
    pub validator_pks: Vec<String>,
    pub kaspa_escrow_addr: String,
    pub kaspa_escrow_private_key: Option<String>, // only populated if kaspa escrow validator

    pub multisig_threshold_hub_ism: usize, // TODO: no need for it to be config, can actually query from dymension destination object
    pub multisig_threshold_kaspa: usize,

    // see https://github.com/dymensionxyz/hyperlane-monorepo/blob/c5d733804d3713e8566d6b23366f7eed4917ee2a/rust/main/chains/hyperlane-cosmos-native/src/providers/grpc.rs#L77
    pub hub_grpc_urls: Vec<Url>,
}

impl ConnectionConf {
    /// Create a new connection configuration
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        wallet_secret: String,
        kaspa_rpc_url: String,
        kaspa_rest_url: Url,
        validator_ids: Vec<H256>,
        validator_hosts: Vec<String>,
        validator_pks: Vec<String>,
        escrow_address: String,
        kaspa_escrow_private_key: Option<String>,
        multisig_threshold_hub_ism: usize,
        multisig_threshold_kaspa_schnorr: usize,
        hub_grpc_urls: Vec<Url>,
    ) -> Self {
        Self {
            wallet_secret,
            kaspa_rpc_url,
            kaspa_rest_url,
            validator_ids,
            validator_hosts,
            validator_pks,
            kaspa_escrow_addr: escrow_address,
            kaspa_escrow_private_key,
            multisig_threshold_hub_ism,
            multisig_threshold_kaspa: multisig_threshold_kaspa_schnorr,
            hub_grpc_urls,
        }
    }
}

/// Untyped kaspa amount
#[derive(serde::Serialize, serde::Deserialize, new, Clone, Debug)]
pub struct RawKaspaAmount {
    /// Coin denom (e.g. `untrn`)
    pub denom: String,
    /// Amount in the given denom
    pub amount: String,
}

/// Typed kaspa amount
#[derive(Clone, Debug)]
pub struct KaspaAmount {
    /// Coin denom (e.g. `untrn`)
    pub denom: String,
    /// Amount in the given denom
    pub amount: FixedPointNumber,
}

impl TryFrom<RawKaspaAmount> for KaspaAmount {
    type Error = ChainCommunicationError;
    fn try_from(raw: RawKaspaAmount) -> Result<Self, ChainCommunicationError> {
        Ok(Self {
            denom: raw.denom,
            amount: FixedPointNumber::from_str(&raw.amount)?,
        })
    }
}

/// An error type when parsing a connection configuration.
#[derive(thiserror::Error, Debug)]
pub enum ConnectionConfError {}
