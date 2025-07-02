use tonic::async_trait;

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, Checkpoint,
    CheckpointWithMessageId, Signature, SignedCheckpointWithMessageId, SignedType, H256, U256,
};

use bytes::Bytes;
use eyre::Result;
use reqwest::StatusCode;
use tracing::{error, info};

use crate::ConnectionConf;

use crate::endpoints::*;
use axum::Json;
use dym_kas_core::{confirmation::ConfirmationFXG, deposit::DepositFXG, withdraw::WithdrawFXG};
use kaspa_wallet_pskt::prelude::Bundle;

#[derive(Debug, Clone)]
pub struct ValidatorsClient {
    pub conf: ConnectionConf,
}

#[async_trait]
impl BlockNumberGetter for ValidatorsClient {
    // TODO: needed?
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}

/// It needs to
/// 1. Call validator.G() to see if validator is OK with a new deposit on Kaspa
/// 2. Call validator.G() to get a signed batch of PSKT for withdrawal TX flow
/// 2. Call validator.G() to see if validator is OK with a confirmation of withdrawal on Kaspa
impl ValidatorsClient {
    /// Returns a new Rpc Provider
    pub fn new(
        conf: ConnectionConf,
        // TODO: prom metrics?
    ) -> ChainResult<Self> {
        Ok(ValidatorsClient { conf })
    }

    /// this runs on relayer
    pub async fn get_deposit_sigs(
        &self,
        fxg: &DepositFXG,
    ) -> ChainResult<Vec<SignedCheckpointWithMessageId>> {
        // TODO: in parallel
        info!(
            "Dymension, asking validators for deposit sigs, number of validators: {:?}",
            self.conf.validator_hosts.len()
        );
        let mut results = Vec::new();
        for host in self.conf.validator_hosts.clone().into_iter() {
            //         let checkpoints = futures::future::join_all(futures).await; TODO: Parallel
            let h = host.to_string();
            let res = request_validate_new_deposits(host, fxg).await;
            match res {
                Ok(r) => match r {
                    Some(sig) => {
                        results.push(sig);
                        info!("Dymension, got deposit sig response ok, validator: {:?}", h);
                    }
                    None => {
                        error!(
                            "Dymension, got deposit sig response None, validator: {:?}",
                            h
                        );
                    }
                },
                Err(e) => {
                    error!(
                        "Dymension, got deposit sig response Err, validator: {:?}, error: {:?}",
                        h, e
                    );
                }
            }
        }
        Ok(results)
    }

    /// this runs on relayer
    pub async fn get_confirmation_sigs(
        &self,
        fxg: &ConfirmationFXG,
    ) -> ChainResult<Vec<Signature>> {
        // map validator addr to sig(s)
        // TODO: in parallel
        let mut results = Vec::new();
        for host in self.conf.validator_hosts.clone().into_iter() {
            //         let checkpoints = futures::future::join_all(futures).await; TODO: Parallel
            let h = host.to_string();
            let res = request_validate_new_confirmation(host, fxg).await;
            match res {
                Ok(r) => match r {
                    Some(sig) => {
                        results.push(sig);
                        info!(
                            "Dymension, got confirmation sig response ok, validator: {:?}",
                            h
                        );
                    }
                    None => {
                        error!(
                            "Dymension, got confirmation sig response None, validator: {:?}",
                            h
                        );
                    }
                },
                Err(_e) => {
                    error!(
                        "Dymension, got confirmation sig response Err, validator: {:?}",
                        h
                    );
                }
            }
        }
        Ok(results)
    }

    /// this runs on relayer
    pub async fn get_withdraw_sigs(&self, fxg: &WithdrawFXG) -> ChainResult<Vec<Bundle>> {
        // returns bundle of signer
        // map validator addr to sig(s)
        // TODO: in parallel
        let mut results = Vec::new();
        for host in self.conf.validator_hosts.clone().into_iter() {
            //         let checkpoints = futures::future::join_all(futures).await; TODO: Parallel
            let h = host.to_string();
            let res = request_sign_withdrawal_bundle(host, fxg).await;

            // TODO: should also check that each validator signed either all or none of the bundle
            match res {
                Ok(r) => match r {
                    Some(sig) => {
                        results.push(sig);
                        info!(
                            "Dymension, got withdrawal sig response ok, validator: {:?}",
                            h
                        );
                    }
                    None => {
                        error!(
                            "Dymension, got withdrawal sig response None, validator: {:?}",
                            h
                        );
                    }
                },
                Err(_e) => {
                    error!(
                        "Dymension, got withdrawal sig response Err, validator: {:?}",
                        h
                    );
                }
            }
        }
        Ok(results)
    }

    pub fn multisig_threshold_hub_ism(&self) -> usize {
        // TODO: clearly distinguish with kaspa multisig
        self.conf.multisig_threshold_hub_ism
    }
}

// see https://github.com/dymensionxyz/hyperlane-monorepo/blob/fe1c79156f5ef6ead5bc60f26a373d0867848532/rust/main/hyperlane-base/src/types/local_storage.rs#L80
pub async fn request_validate_new_deposits(
    host: String,
    deposits: &DepositFXG,
) -> Result<Option<SignedCheckpointWithMessageId>> {
    info!(
        "Dymension, requesting deposit sigs from validator: {:?}",
        host
    );
    let bz = Bytes::from(deposits);
    let c = reqwest::Client::new();
    let res = c
        // calls to https://github.com/dymensionxyz/hyperlane-monorepo/blob/1a603d65e0073037da896534fc52da4332a7a7b1/rust/main/chains/dymension-kaspa/src/router.rs#L40
        .post(format!("{}{}", host, ROUTE_VALIDATE_NEW_DEPOSITS))
        .body(bz)
        .send()
        .await?;

    // TODO: need to return sigs here
    let status = res.status();
    if status == StatusCode::OK {
        let body = res.json::<SignedCheckpointWithMessageId>().await?;
        Ok(Some(body))
    } else {
        Err(eyre::eyre!("Failed to validate deposits: {}", status))
    }
}

pub async fn request_validate_new_confirmation(
    host: String,
    confirmation: &ConfirmationFXG,
) -> Result<Option<Signature>> {
    let bz = Bytes::from(confirmation);
    let c = reqwest::Client::new();
    let res = c
        .post(format!("{}{}", host, ROUTE_VALIDATE_CONFIRMED_WITHDRAWALS))
        .body(bz)
        .send()
        .await?;

    let status = res.status();
    if status == StatusCode::OK {
        let body = res.json::<Signature>().await?;
        Ok(Some(body))
    } else {
        Err(eyre::eyre!("Failed to validate confirmation: {}", status))
    }
}

pub async fn request_sign_withdrawal_bundle(
    host: String,
    bundle: &WithdrawFXG,
) -> Result<Option<Bundle>> {
    let bz = Bytes::try_from(bundle)?;
    let c = reqwest::Client::new();
    let res = c
        .post(format!("{}{}", host, ROUTE_SIGN_PSKTS))
        .body(bz)
        .send()
        .await?;

    let status = res.status();
    if status == StatusCode::OK {
        let body = res.json::<String>().await?;
        let bundle = Bundle::deserialize(&body)?;
        Ok(Some(bundle))
    } else {
        Err(eyre::eyre!("Failed to sign withdrawal bundle: {}", status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dym_kas_core::deposit::DepositFXG;

    #[tokio::test]
    #[ignore = "Requires real validator server"]
    async fn test_server_smoke() {
        let host = "http://localhost:9090"; // local validator
        let deposits = DepositFXG::default();
        let res = request_validate_new_deposits(host.to_string(), &deposits).await;
        let _ = res;
        println!("res: {:?}", res);
    }

    #[tokio::test]
    async fn test_body_json() {
        let sig: SignedType<CheckpointWithMessageId> = SignedType {
            value: CheckpointWithMessageId {
                checkpoint: Checkpoint {
                    merkle_tree_hook_address: H256::default(),
                    mailbox_domain: 0,
                    root: H256::default(),
                    index: 0,
                },
                message_id: H256::default(),
            },
            signature: Signature {
                r: U256::default(),
                s: U256::default(),
                v: 0,
            },
        };
        _ = sig;
    }
}
