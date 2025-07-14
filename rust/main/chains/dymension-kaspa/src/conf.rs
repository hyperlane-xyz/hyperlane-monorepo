use std::str::FromStr;

use derive_new::new;
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, FixedPointNumber, NativeToken, H256,
};

/// Kaspa connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /*
    Used for both agents, since we need WRPC client for both and the easiest way to get the wrpc client is through the wallet
    Should fix
     */
    pub wallet_secret: String,

    pub kaspa_rpc_url: String, // direct connection to kaspa DAG node .e.g localhost:17210
    pub kaspa_rest_url: Url, // connection to Kaspa higher level indexer server e.g. https://api.kaspa.org

    /*
    Used by both, since it's used to build escrow public object, which is used by both agents
     */
    pub validator_pub_keys: Vec<String>,

    pub kaspa_escrow_addr: String, // TODO: could be derived from pub keys and removed

    pub multisig_threshold_hub_ism: usize, // TODO: no need for it to be config, can actually query from dymension destination object
    pub multisig_threshold_kaspa: usize,

    // see https://github.com/dymensionxyz/hyperlane-monorepo/blob/c5d733804d3713e8566d6b23366f7eed4917ee2a/rust/main/chains/hyperlane-cosmos-native/src/providers/grpc.rs#L77
    pub hub_grpc_urls: Vec<Url>,
    pub op_submission_config: OpSubmissionConfig,

    pub validator_stuff: Option<ValidatorStuff>,
    pub relayer_stuff: Option<RelayerStuff>,
}

#[derive(Debug, Clone)]
pub struct ValidatorStuff {
    pub hub_domain: u32,
    pub hub_token_id: H256,
    pub kas_domain: u32,
    pub kas_token_placeholder: H256,
    pub hub_mailbox_id: String,
    pub kas_escrow_private: String,
    pub toggles: ValidationConf, // only relevant for validator
}

#[derive(Debug, Clone)]
pub struct RelayerStuff {
    pub validator_hosts: Vec<String>,
    pub deposit_look_back_mins: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ValidationConf {
    pub deposit_enabled: bool,
    pub withdrawal_enabled: bool,
    pub withdrawal_confirmation_enabled: bool,
}

impl ValidationConf {
    pub fn default() -> Self {
        Self {
            deposit_enabled: true,
            withdrawal_enabled: true,
            withdrawal_confirmation_enabled: true,
        }
    }
}

impl ConnectionConf {
    /// Create a new connection configuration
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        wallet_secret: String,
        kaspa_rpc_url: String,
        kaspa_rest_url: Url,
        validator_hosts: Vec<String>,
        validator_pub_keys: Vec<String>,
        escrow_address: String,
        kaspa_escrow_private_key: Option<String>,
        multisig_threshold_hub_ism: usize,
        multisig_threshold_kaspa_schnorr: usize,
        hub_grpc_urls: Vec<Url>,
        deposit_look_back_mins: Option<u64>,
        hub_mailbox_id: String,
        op_submission_config: OpSubmissionConfig,
        validation_conf: ValidationConf,

        // we could query these two instead
        hub_domain: u32,
        hub_token_id: H256,

        kas_domain: u32,
        kas_token_placeholder: H256,
    ) -> Self {
        let v = match &kaspa_escrow_private_key {
            Some(kas_escrow_private) => {
                if hub_domain == 0 || kas_domain == 0 || hub_token_id == H256::default() {
                    panic!("Missing validator config: hub_domain: {}, kas_domain: {}, hub_token_id: {}, kas_token_placeholder: {}", hub_domain, kas_domain, hub_token_id, kas_token_placeholder)
                } else {
                    Some(ValidatorStuff {
                        hub_domain,
                        hub_token_id,
                        kas_domain,
                        kas_token_placeholder,
                        hub_mailbox_id,
                        kas_escrow_private: kas_escrow_private.clone(),
                        toggles: validation_conf,
                    })
                }
            }
            None => None,
        };

        let r = match &kaspa_escrow_private_key {
            None => Some(RelayerStuff {
                deposit_look_back_mins,
                validator_hosts,
            }),
            Some(_) => None,
        };

        Self {
            wallet_secret,
            kaspa_rpc_url,
            kaspa_rest_url,
            validator_stuff: v,
            validator_pub_keys,
            kaspa_escrow_addr: escrow_address,
            multisig_threshold_hub_ism,
            multisig_threshold_kaspa: multisig_threshold_kaspa_schnorr,
            hub_grpc_urls,
            relayer_stuff: r,
            op_submission_config,
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
