use std::str::FromStr;

use derive_new::new;
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, FixedPointNumber, H256, U256,
};

#[derive(Debug, Clone)]
pub struct ConnectionConf {
    // Used by both validator and relayer since easiest way to get WRPC client is through wallet
    pub wallet_secret: String,
    pub wallet_dir: Option<String>,

    pub kaspa_urls_wrpc: Vec<String>, // Direct connection to Kaspa DAG node, e.g. localhost:17210
    pub kaspa_urls_rest: Vec<Url>, // Connection to Kaspa indexer server, e.g. https://api.kaspa.org

    pub wrpc_reconnect_on_error: bool, // Recreate WRPC connection on errors

    // Used by both agents to build escrow public object
    pub validator_pub_keys: Vec<String>,

    pub multisig_threshold_hub_ism: usize, // Could be queried from Dymension destination object instead
    pub multisig_threshold_kaspa: usize,

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
    pub kas_escrow_key_source: KaspaEscrowKeySource,
    pub kaspa_grpc_urls: Vec<String>,
    pub toggles: ValidationConf,
}

#[derive(Debug, Clone)]
pub enum KaspaEscrowKeySource {
    Direct(String),
    Aws(dym_kas_kms::AwsKeyConfig),
}

pub use dym_kas_kms::AwsKeyConfig;

#[derive(Debug, Clone)]
pub struct RelayerStuff {
    pub validator_hosts: Vec<String>,
    pub deposit_timings: RelayerDepositTimings,
    pub tx_fee_multiplier: f64,
    pub max_sweep_inputs: Option<usize>,
    pub max_sweep_bundle_bytes: usize,
    pub validator_request_timeout: std::time::Duration,
}

#[derive(Debug, Clone)]
pub struct RelayerDepositTimings {
    pub poll_interval: std::time::Duration,
    pub retry_delay_base: std::time::Duration,
    pub retry_delay_exponent: f64,
    pub retry_delay_max: std::time::Duration,
    pub deposit_look_back: std::time::Duration,
    pub deposit_query_overlap: std::time::Duration,
}

impl Default for RelayerDepositTimings {
    fn default() -> Self {
        Self {
            poll_interval: std::time::Duration::from_secs(5),
            retry_delay_base: std::time::Duration::from_secs(30),
            retry_delay_exponent: 2.0,
            retry_delay_max: std::time::Duration::from_secs(3600),
            deposit_look_back: std::time::Duration::from_secs(0),
            deposit_query_overlap: std::time::Duration::from_secs(60 * 5),
        }
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
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        wallet_secret: String,
        wallet_dir: Option<String>,
        kaspa_urls_wrpc: Vec<String>,
        kaspa_urls_rest: Vec<Url>,
        validator_hosts: Vec<String>,
        validator_pub_keys: Vec<String>,
        kaspa_escrow_key_source: Option<KaspaEscrowKeySource>,
        kaspa_urls_grpc: Vec<String>,
        multisig_threshold_hub_ism: usize,
        multisig_threshold_kaspa_schnorr: usize,
        hub_grpc_urls: Vec<Url>,
        hub_mailbox_id: String,
        op_submission_config: OpSubmissionConfig,
        _validation_conf: ValidationConf,
        min_deposit_sompi: U256,
        kaspa_time_config: Option<RelayerDepositTimings>,

        hub_domain: u32,
        hub_token_id: H256,

        kas_domain: u32,
        kas_token_placeholder: H256,
        kas_tx_fee_multiplier: f64,
        max_sweep_inputs: Option<usize>,
        validator_request_timeout: std::time::Duration,
        wrpc_reconnect_on_error: Option<bool>,
    ) -> Self {
        let v = match kaspa_escrow_key_source {
            Some(kas_escrow_key_source) => {
                if hub_domain == 0
                    || kas_domain == 0
                    || hub_token_id == H256::default()
                    || kaspa_urls_grpc.is_empty()
                {
                    panic!("Missing validator config: hub_domain: {}, kas_domain: {}, hub_token_id: {}, kas_token_placeholder: {}, kaspaUrlsGrpc: {:?}", hub_domain, kas_domain, hub_token_id, kas_token_placeholder, kaspa_urls_grpc)
                } else {
                    Some(ValidatorStuff {
                        hub_domain,
                        hub_token_id,
                        kas_domain,
                        kas_token_placeholder,
                        hub_mailbox_id,
                        kas_escrow_key_source,
                        kaspa_grpc_urls: kaspa_urls_grpc,
                        toggles: ValidationConf {
                            deposit_enabled: true,
                            withdrawal_enabled: true,
                            withdrawal_confirmation_enabled: true,
                        },
                    })
                }
            }
            None => None,
        };

        let r = match validator_hosts.len() {
            0 => None,
            _ => {
                let deposit_timings = kaspa_time_config.unwrap_or_default();
                Some(RelayerStuff {
                    validator_hosts,
                    deposit_timings,
                    tx_fee_multiplier: kas_tx_fee_multiplier,
                    max_sweep_inputs, // None by default, only enforced if configured
                    // Validator accepts 10 MB body limit. Use 8 MB for sweeping bundle
                    // to leave 2 MB margin for messages, anchors, and protobuf overhead
                    max_sweep_bundle_bytes: 8 * 1024 * 1024,
                    validator_request_timeout,
                })
            }
        };

        Self {
            wallet_secret,
            wallet_dir,
            kaspa_urls_wrpc,
            kaspa_urls_rest,
            wrpc_reconnect_on_error: wrpc_reconnect_on_error.unwrap_or(true),
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

#[derive(serde::Serialize, serde::Deserialize, new, Clone, Debug)]
pub struct RawKaspaAmount {
    pub denom: String,
    pub amount: String,
}

#[derive(Clone, Debug)]
pub struct KaspaAmount {
    pub denom: String,
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

#[derive(thiserror::Error, Debug)]
pub enum ConnectionConfError {}
