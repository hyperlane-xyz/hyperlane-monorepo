use std::str::FromStr;

use derive_new::new;
use serde::Deserialize;
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, FixedPointNumber, H256, U256,
};

/// Escrow validator configuration for withdrawals and migrations.
///
/// # Ordering Requirements
///
/// The order of validators in the config array is significant:
/// The `escrow_pub` keys are extracted in config order to derive the Kaspa multisig escrow address.
/// Changing the order will produce a different escrow address.
/// The order must match the existing production escrow for backwards compatibility.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaValidatorEscrow {
    pub host: String,
    pub escrow_pub: String,
}

/// ISM validator configuration for deposits and confirmations.
///
/// # Ordering Requirements
///
/// ISM signature ordering: Signatures for deposits and confirmations are sorted by ISM address
/// at runtime (lexicographic order of H160 bytes) before submission to the Hub ISM.
/// The relayer handles this sorting automatically.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaValidatorIsm {
    pub host: String,
    pub ism_address: String,
}

#[derive(Debug, Clone)]
pub struct ConnectionConf {
    // Used by both validator and relayer since easiest way to get WRPC client is through wallet
    pub wallet_secret: String,
    pub wallet_dir: Option<String>,

    pub kaspa_urls_wrpc: Vec<String>, // Direct connection to Kaspa DAG node, e.g. localhost:17210
    pub kaspa_urls_rest: Vec<Url>, // Connection to Kaspa indexer server, e.g. https://api.kaspa.org

    // Used by both agents to build escrow public object
    pub validator_pub_keys: Vec<String>,

    pub multisig_threshold_hub_ism: usize, // Could be queried from Dymension destination object instead
    pub multisig_threshold_kaspa: usize,

    pub hub_grpc_urls: Vec<Url>,
    pub op_submission_config: OpSubmissionConfig,

    pub min_deposit_sompi: U256,
    pub validator_stuff: Option<ValidatorStuff>,
    pub relayer_stuff: Option<RelayerStuff>,

    /// If set, enables migration mode.
    /// For validators: only migration TX signing and confirmation are allowed.
    /// For relayers: run escrow key migration to this address and exit.
    pub migrate_escrow_to: Option<String>,
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

impl KaspaEscrowKeySource {
    /// Load the Kaspa escrow keypair from the configured source.
    pub async fn load_keypair(&self) -> eyre::Result<kaspa_bip32::secp256k1::Keypair> {
        match self {
            KaspaEscrowKeySource::Direct(json_str) => serde_json::from_str(json_str)
                .map_err(|e| eyre::eyre!("parse Kaspa keypair from JSON: {}", e)),
            KaspaEscrowKeySource::Aws(aws_config) => {
                dym_kas_kms::load_kaspa_keypair_from_aws(aws_config)
                    .await
                    .map_err(|e| eyre::eyre!("load Kaspa keypair from AWS: {}", e))
            }
        }
    }
}

pub use dym_kas_kms::AwsKeyConfig;

#[derive(Debug, Clone)]
pub struct RelayerStuff {
    /// Escrow signers (for withdrawals and migration)
    pub validators_escrow: Vec<KaspaValidatorEscrow>,
    /// ISM signers (for deposits and confirmations)
    pub validators_ism: Vec<KaspaValidatorIsm>,
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
    pub validate_deposits: bool,
    pub validate_withdrawals: bool,
    pub validate_confirmations: bool,
}

impl Default for ValidationConf {
    fn default() -> Self {
        Self {
            validate_deposits: true,
            validate_withdrawals: true,
            validate_confirmations: true,
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
        validators_escrow: Vec<KaspaValidatorEscrow>,
        validators_ism: Vec<KaspaValidatorIsm>,
        kaspa_escrow_key_source: Option<KaspaEscrowKeySource>,
        kaspa_urls_grpc: Vec<String>,
        multisig_threshold_hub_ism: usize,
        multisig_threshold_kaspa_schnorr: usize,
        hub_grpc_urls: Vec<Url>,
        hub_mailbox_id: String,
        op_submission_config: OpSubmissionConfig,
        validation_conf: ValidationConf,
        min_deposit_sompi: U256,
        kaspa_time_config: Option<RelayerDepositTimings>,

        hub_domain: u32,
        hub_token_id: H256,

        kas_domain: u32,
        kas_token_placeholder: H256,
        kas_tx_fee_multiplier: f64,
        max_sweep_inputs: Option<usize>,
        validator_request_timeout: std::time::Duration,
        migrate_escrow_to: Option<String>,
    ) -> Self {
        // Extract escrow pub keys from escrow validators (used by both validator and relayer)
        let validator_pub_keys: Vec<String> = validators_escrow
            .iter()
            .map(|v| v.escrow_pub.clone())
            .collect();

        // Check if this is a relayer config (has validator hosts configured)
        let has_relayer_config = validators_escrow.iter().any(|v| !v.host.is_empty());

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
                        toggles: validation_conf,
                    })
                }
            }
            None => None,
        };

        let r = if has_relayer_config {
            let deposit_timings = kaspa_time_config.unwrap_or_default();
            Some(RelayerStuff {
                validators_escrow,
                validators_ism,
                deposit_timings,
                tx_fee_multiplier: kas_tx_fee_multiplier,
                max_sweep_inputs,
                max_sweep_bundle_bytes: 8 * 1024 * 1024,
                validator_request_timeout,
            })
        } else {
            None
        };

        // Log early (before tracing is initialized) so migration mode is visible even if wallet connection fails
        println!(
            "Kaspa config: is_migration_mode={}, migration_target={:?}",
            migrate_escrow_to.is_some(),
            migrate_escrow_to.as_deref()
        );

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
            migrate_escrow_to,
        }
    }

    /// Returns true if migration mode is active.
    pub fn is_migration_mode(&self) -> bool {
        self.migrate_escrow_to.is_some()
    }

    /// Returns the parsed migration target address if in migration mode.
    pub fn parsed_migration_target(&self) -> Option<kaspa_addresses::Address> {
        self.migrate_escrow_to
            .as_ref()
            .and_then(|s| kaspa_addresses::Address::try_from(s.as_str()).ok())
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
