use std::str::FromStr;

use derive_new::new;
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, FixedPointNumber, H256, U256,
};

/// Kaspa connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /*
    Used for both agents, since we need WRPC client for both and the easiest way to get the wrpc client is through the wallet
    Should fix
     */
    pub wallet_secret: String,
    pub wallet_dir: Option<String>, // optionally override default kaspa wallet directory

    pub kaspa_urls_wrpc: Vec<String>, // direct connection to kaspa DAG node .e.g localhost:17210
    pub kaspa_urls_rest: Vec<Url>, // connection to Kaspa higher level indexer server e.g. https://api.kaspa.org

    /*
    Used by both, since it's used to build escrow public object, which is used by both agents
     */
    pub validator_pub_keys: Vec<String>,

    pub multisig_threshold_hub_ism: usize, // TODO: no need for it to be config, can actually query from dymension destination object
    pub multisig_threshold_kaspa: usize,

    // see https://github.com/dymensionxyz/hyperlane-monorepo/blob/c5d733804d3713e8566d6b23366f7eed4917ee2a/rust/main/chains/hyperlane-cosmos-native/src/providers/grpc.rs#L77
    pub hub_grpc_urls: Vec<Url>,
    pub op_submission_config: OpSubmissionConfig,

    pub min_deposit_sompi: U256,

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
    pub kaspa_deposit_config: KaspaDepositConfig,
}

#[derive(Debug, Clone)]
pub struct KaspaDepositConfig {
    /// Number of blue score confirmations required for finality
    pub finality_confirmations: u32,
    /// Base retry delay in seconds (used for exponential backoff)
    pub base_retry_delay_secs: u64,
    /// Polling interval for checking new deposits
    pub poll_interval_secs: u64,
}

impl Default for KaspaDepositConfig {
    fn default() -> Self {
        Self {
            finality_confirmations: 1000,
            base_retry_delay_secs: 30,
            poll_interval_secs: 10,
        }
    }
}

impl KaspaDepositConfig {
    pub fn poll_interval(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.poll_interval_secs)
    }

    pub fn base_retry_delay(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.base_retry_delay_secs)
    }
}

#[derive(Debug, Clone)]
pub struct ValidationConf {
    pub deposit_enabled: bool,
    pub withdrawal_enabled: bool,
    pub withdrawal_confirmation_enabled: bool,
}

impl Default for ValidationConf {
    fn default() -> Self {
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
        wallet_dir: Option<String>,
        kaspa_urls_wrpc: Vec<String>,
        kaspa_urls_rest: Vec<Url>,
        validator_hosts: Vec<String>,
        validator_pub_keys: Vec<String>,
        kaspa_escrow_private_key: Option<String>,
        multisig_threshold_hub_ism: usize,
        multisig_threshold_kaspa_schnorr: usize,
        hub_grpc_urls: Vec<Url>,
        deposit_look_back_mins: Option<u64>,
        hub_mailbox_id: String,
        op_submission_config: OpSubmissionConfig,
        validation_conf: ValidationConf,
        min_deposit_sompi: U256,
        kaspa_deposit_config: Option<KaspaDepositConfig>,

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

        let r = match validator_hosts.len() {
            0 => None,
            _ => Some(RelayerStuff {
                deposit_look_back_mins,
                validator_hosts,
                kaspa_deposit_config: kaspa_deposit_config.unwrap_or_default(),
            }),
        };

        Self {
            wallet_secret,
            wallet_dir,
            kaspa_urls_wrpc,
            kaspa_urls_rest,
            validator_stuff: v,
            validator_pub_keys,
            multisig_threshold_hub_ism,
            multisig_threshold_kaspa: multisig_threshold_kaspa_schnorr,
            hub_grpc_urls,
            relayer_stuff: r,
            op_submission_config,
            min_deposit_sompi,
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
