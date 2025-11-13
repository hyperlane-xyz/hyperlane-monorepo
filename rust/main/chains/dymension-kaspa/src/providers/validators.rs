use tonic::async_trait;

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, Signature,
    SignedCheckpointWithMessageId,
};

use bytes::Bytes;
use eyre::eyre;
use eyre::Result;
use reqwest::StatusCode;
use tracing::{error, info};

use crate::ConnectionConf;

use crate::endpoints::*;
use dym_kas_core::{confirmation::ConfirmationFXG, deposit::DepositFXG, withdraw::WithdrawFXG};
use futures::future::join_all;
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

impl ValidatorsClient {
    fn hosts(&self) -> Vec<String> {
        self.conf
            .relayer_stuff
            .as_ref()
            .unwrap()
            .validator_hosts
            .clone()
    }

    pub fn new(
        cfg: ConnectionConf,
        // TODO: prom metrics?
    ) -> ChainResult<Self> {
        Ok(ValidatorsClient { conf: cfg })
    }

    pub async fn get_deposit_sigs(
        &self,
        fxg: &DepositFXG,
    ) -> ChainResult<Vec<SignedCheckpointWithMessageId>> {
        info!(
            validators_count = self.hosts().len(),
            "dymension: asking validators for deposit sigs"
        );

        let futures = self.hosts().into_iter().map(|host| async move {
            let h = host.to_string();
            match request_validate_new_deposits(host, fxg).await {
                Ok(Some(sig)) => {
                    info!(validator = ?h, "dymension: got deposit sig response ok");
                    Ok((h, sig))
                }
                Ok(None) => {
                    error!(
                        validator = ?h,
                        "dymension: got deposit sig response None"
                    );
                    Err(eyre!("No signature received"))
                }
                Err(e) => {
                    let error_str = e.to_string();
                    if error_str.contains("TransactionRejected") {
                        error!(
                            validator = ?h,
                            error = ?e,
                            "dymension: transaction rejected"
                        );
                        // This is non-retryable - mark as permanent failure
                        Err(e)
                    } else if error_str.contains("ServiceUnavailable") {
                        error!(
                            validator = ?h,
                            error = ?e,
                            "dymension: service unavailable"
                        );
                        // This is retryable with longer backoff
                        Err(e)
                    } else {
                        error!(
                            validator = ?h,
                            error = ?e,
                            "dymension: got deposit sig response Err"
                        );
                        Err(e)
                    }
                }
            }
        });

        let results = join_all(futures).await;
        let sigs: Vec<(String, SignedCheckpointWithMessageId)> =
            results.into_iter().filter_map(Result::ok).collect();

        let hosts = self.hosts();
        let mut sig_map = sigs
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        let sigs = hosts
            .into_iter()
            .filter_map(|h| sig_map.remove(&h))
            .collect::<Vec<SignedCheckpointWithMessageId>>();

        Ok(sigs)
    }

    pub async fn get_confirmation_sigs(
        &self,
        fxg: &ConfirmationFXG,
    ) -> ChainResult<Vec<Signature>> {
        info!(
            validators_count = self.hosts().len(),
            fxg = ?fxg,
            "dymension: getting confirmation sigs"
        );

        let futures = self
        .hosts()
        .into_iter()
        .map(|host| {
            let fxg_clone = fxg.clone();
            async move {
                let h = host.to_string();
                match request_validate_new_confirmation(host, &fxg_clone).await {
                    Ok(Some(sig)) => {
                        info!(validator = ?h, "dymension: got confirmation sig response ok");
                        Ok((h, sig))
                    }
                    Ok(None) => {
                        error!(validator = ?h, "dymension: got confirmation sig response None");
                        Err(eyre!("No signature received"))
                    }
                    Err(e) => {
                        error!(validator = ?h, error = ?e, "dymension: got confirmation sig response Err");
                        Err(e)
                    }
                }
            }
        });

        let results = join_all(futures).await;
        let sigs: Vec<(String, Signature)> = results.into_iter().filter_map(Result::ok).collect();

        let hosts = self.hosts();
        let mut sig_map = sigs
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        let sigs = hosts
            .into_iter()
            .filter_map(|h| sig_map.remove(&h))
            .collect::<Vec<Signature>>();

        Ok(sigs)
    }

    pub async fn get_withdraw_sigs(&self, fxg: &WithdrawFXG) -> ChainResult<Vec<Bundle>> {
        info!(
            validators_count = self.hosts().len(),
            "dymension: getting withdrawal sigs"
        );

        let futures = self.hosts().into_iter().map(|host| async move {
            let h = host.to_string();
            match request_sign_withdrawal_bundle(host, fxg).await {
                Ok(Some(bundle)) => {
                    info!(
                        validator = ?h,
                        "dymension: got withdrawal sig response ok"
                    );
                    Ok(bundle)
                }
                Ok(None) => {
                    error!(
                        validator = ?h,
                        "dymension: got withdrawal sig response None"
                    );
                    Err(eyre!("No bundle received"))
                }
                Err(e) => {
                    error!(
                        validator = ?h,
                        error = ?e,
                        "dymension: got withdrawal sig response Err"
                    );
                    Err(e)
                }
            }
        });

        let results = join_all(futures).await;
        let successful_bundles: Vec<Bundle> = results.into_iter().filter_map(Result::ok).collect();
        Ok(successful_bundles)
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
        validator = %host,
        "dymension: requesting deposit sigs from validator"
    );
    let bz = Bytes::from(deposits);
    let client = reqwest::Client::new();
    let res = client
        // calls to https://github.com/dymensionxyz/hyperlane-monorepo/blob/1a603d65e0073037da896534fc52da4332a7a7b1/rust/main/chains/dymension-kaspa/src/router.rs#L40
        .post(format!("{}{}", host, ROUTE_VALIDATE_NEW_DEPOSITS))
        .body(bz)
        .send()
        .await?;

    let status = res.status();
    if status == StatusCode::OK {
        let body = res.json::<SignedCheckpointWithMessageId>().await?;
        Ok(Some(body))
    } else {
        let err_msg = res.text().await.unwrap_or_else(|_| status.to_string());

        // Create more specific errors based on HTTP status code for retry semantics
        let err = match status {
            StatusCode::ACCEPTED => {
                // 202 Accepted: Deposit not final, retryable with backoff
                eyre::eyre!("DepositNotFinal: {}", err_msg)
            }
            StatusCode::UNPROCESSABLE_ENTITY => {
                // 422 Unprocessable Entity: Transaction rejected, non-retryable
                eyre::eyre!("TransactionRejected: {}", err_msg)
            }
            StatusCode::SERVICE_UNAVAILABLE => {
                // 503 Service Unavailable: Service down, retryable
                eyre::eyre!("ServiceUnavailable: {}", err_msg)
            }
            _ => {
                eyre::eyre!("ValidationFailed: {} - {}", status, err_msg)
            }
        };

        Err(err)
    }
}

pub async fn request_validate_new_confirmation(
    host: String,
    conf: &ConfirmationFXG,
) -> Result<Option<Signature>> {
    let bz = Bytes::try_from(conf)?;
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}{}", host, ROUTE_VALIDATE_CONFIRMED_WITHDRAWALS))
        .body(bz)
        .send()
        .await?;

    let status = res.status();
    if status == StatusCode::OK {
        let body = res.json::<Signature>().await?;
        Ok(Some(body))
    } else {
        let err_msg = res.text().await.unwrap_or_else(|_| status.to_string());
        Err(eyre::eyre!(
            "Failed to validate confirmation: {} - {}",
            status,
            err_msg
        ))
    }
}

pub async fn request_sign_withdrawal_bundle(
    host: String,
    fxg: &WithdrawFXG,
) -> Result<Option<Bundle>> {
    info!(
        validator = %host,
        "dymension: requesting withdrawal sigs from validator"
    );
    let bz = Bytes::try_from(fxg)?;
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}{}", host, ROUTE_SIGN_PSKTS))
        .body(bz)
        .send()
        .await?;

    let status = res.status();
    if status == StatusCode::OK {
        let bundle = res.json::<Bundle>().await?;
        Ok(Some(bundle))
    } else {
        let err_msg = res.text().await.unwrap_or_else(|_| status.to_string());
        Err(eyre::eyre!(
            "Failed to sign withdrawal bundle: {} - {}",
            status,
            err_msg
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dym_kas_core::deposit::DepositFXG;
    use hyperlane_core::{Checkpoint, CheckpointWithMessageId, SignedType, H256, U256};

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
