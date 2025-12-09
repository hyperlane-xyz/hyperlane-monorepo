use tonic::async_trait;

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, Signature,
    SignedCheckpointWithMessageId, H160,
};

use bytes::Bytes;
use eyre::Result;
use reqwest::StatusCode;
use std::str::FromStr;
use tracing::{error, info};

use crate::ConnectionConf;
use futures::stream::{FuturesUnordered, StreamExt};
use std::sync::Arc;
use std::time::Instant;

use crate::endpoints::*;
use crate::kas_bridge::{
    confirmation::ConfirmationFXG, deposit::DepositFXG, withdraw::WithdrawFXG,
};
use kaspa_wallet_pskt::prelude::Bundle;

#[derive(Clone)]
pub struct ValidatorsClient {
    pub conf: ConnectionConf,
    http_client: reqwest::Client,
    metrics: Option<prometheus::HistogramVec>,
}

impl std::fmt::Debug for ValidatorsClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ValidatorsClient")
            .field("conf", &self.conf)
            .finish()
    }
}

#[async_trait]
impl BlockNumberGetter for ValidatorsClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"))
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

    fn ism_addresses(&self) -> Vec<String> {
        self.conf
            .relayer_stuff
            .as_ref()
            .unwrap()
            .validator_ism_addresses
            .clone()
    }

    async fn collect_with_threshold<T, F, V>(
        hosts: Vec<String>,
        metrics: Option<prometheus::HistogramVec>,
        request_type: &str,
        threshold: usize,
        request_fn: F,
        validate_fn: Option<V>,
    ) -> ChainResult<Vec<T>>
    where
        T: Send + 'static,
        F: Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send>>
            + Send
            + Sync
            + 'static,
        V: Fn(usize, &String, &T) -> bool + Send + Sync + 'static,
    {
        let mut futures: FuturesUnordered<_> = hosts
            .iter()
            .enumerate()
            .map(|(index, host)| {
                let host = host.clone();
                let request_type = request_type.to_string();
                let start = Instant::now();
                let fut = request_fn(host.clone());
                let metrics_clone = metrics.clone();

                async move {
                    let result = fut.await;
                    let duration = start.elapsed();
                    let status = if result.is_ok() { "success" } else { "failure" };

                    if let Some(metrics) = &metrics_clone {
                        metrics
                            .with_label_values(&[&host, &request_type, status])
                            .observe(duration.as_secs_f64());
                    }

                    (index, host, result, duration)
                }
            })
            .collect();

        let mut successes: Vec<(usize, T)> = Vec::new();

        while let Some((index, host, result, duration)) = futures.next().await {
            match result {
                Ok(value) => {
                    let valid = match &validate_fn {
                        Some(validator) => validator(index, &host, &value),
                        None => true,
                    };

                    if valid {
                        info!(
                            validator = ?host,
                            validator_index = index,
                            duration_ms = duration.as_millis(),
                            request_type = request_type,
                            "kaspa: validator response success"
                        );
                        successes.push((index, value));

                        if successes.len() >= threshold {
                            info!(
                                collected = successes.len(),
                                threshold = threshold,
                                remaining = futures.len(),
                                request_type = request_type,
                                "kaspa: reached threshold, returning early"
                            );

                            let request_type_owned = request_type.to_string();
                            tokio::spawn(async move {
                                while let Some((_, host, result, _duration)) = futures.next().await
                                {
                                    if let Err(e) = result {
                                        error!(
                                            validator = ?host,
                                            error = ?e,
                                            request_type = %request_type_owned,
                                            "kaspa: background validator failed"
                                        );
                                    }
                                }
                            });

                            successes.sort_by_key(|(idx, _)| *idx);
                            return Ok(successes.into_iter().map(|(_, v)| v).collect());
                        }
                    }
                }
                Err(e) => {
                    error!(
                        validator = ?host,
                        validator_index = index,
                        error = ?e,
                        duration_ms = duration.as_millis(),
                        request_type = request_type,
                        "kaspa: validator response failed"
                    );
                }
            }
        }

        Err(ChainCommunicationError::from_other_str(&format!(
            "collect {}: threshold={} but got only {} successes from {} validators",
            request_type,
            threshold,
            successes.len(),
            hosts.len()
        )))
    }

    pub fn new(
        cfg: ConnectionConf,
        metrics: Option<prometheus::HistogramVec>,
    ) -> ChainResult<Self> {
        let timeout = cfg
            .relayer_stuff
            .as_ref()
            .map(|r| r.validator_request_timeout)
            .unwrap_or(std::time::Duration::from_secs(15));

        let http_client = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| {
                ChainCommunicationError::from_other_str(&format!("build HTTP client: {}", e))
            })?;

        Ok(ValidatorsClient {
            conf: cfg,
            http_client,
            metrics,
        })
    }

    pub async fn get_deposit_sigs(
        &self,
        fxg: &DepositFXG,
    ) -> ChainResult<Vec<SignedCheckpointWithMessageId>> {
        let threshold = self.multisig_threshold_hub_ism();
        let client = self.http_client.clone();
        let hosts = self.hosts();
        let expected_addresses = self.ism_addresses();
        let metrics = self.metrics.clone();
        let fxg = fxg.clone();

        let validator = if expected_addresses.is_empty() {
            None
        } else {
            Some(
                move |index: usize,
                      host: &String,
                      signed_checkpoint: &SignedCheckpointWithMessageId| {
                    if let Some(expected) = expected_addresses.get(index) {
                        match H160::from_str(expected) {
                            Ok(expected_h160) => match signed_checkpoint.recover() {
                                Ok(recovered_signer) => {
                                    if recovered_signer != expected_h160 {
                                        error!(
                                            validator = ?host,
                                            validator_index = index,
                                            expected_signer = ?expected_h160,
                                            actual_signer = ?recovered_signer,
                                            "kaspa: signature verification failed - signer mismatch"
                                        );
                                        false
                                    } else {
                                        true
                                    }
                                }
                                Err(e) => {
                                    error!(
                                        validator = ?host,
                                        validator_index = index,
                                        error = ?e,
                                        "kaspa: failed to recover signer from signature"
                                    );
                                    false
                                }
                            },
                            Err(e) => {
                                error!(
                                    validator = ?host,
                                    validator_index = index,
                                    expected_address = ?expected,
                                    error = ?e,
                                    "kaspa: failed to parse expected ISM address"
                                );
                                false
                            }
                        }
                    } else {
                        true
                    }
                },
            )
        };

        Self::collect_with_threshold(
            hosts,
            metrics,
            "deposit",
            threshold,
            move |host| {
                let client = client.clone();
                let fxg = fxg.clone();
                Box::pin(async move { request_validate_new_deposits(&client, host, &fxg).await })
            },
            validator,
        )
        .await
    }

    pub async fn get_confirmation_sigs(
        &self,
        fxg: &ConfirmationFXG,
    ) -> ChainResult<Vec<Signature>> {
        let threshold = self.multisig_threshold_hub_ism();
        let client = self.http_client.clone();
        let hosts = self.hosts();
        let metrics = self.metrics.clone();
        let fxg = fxg.clone();

        Self::collect_with_threshold(
            hosts,
            metrics,
            "confirmation",
            threshold,
            move |host| {
                let client = client.clone();
                let fxg = fxg.clone();
                Box::pin(
                    async move { request_validate_new_confirmation(&client, host, &fxg).await },
                )
            },
            None::<fn(usize, &String, &Signature) -> bool>,
        )
        .await
    }

    pub async fn get_withdraw_sigs(&self, fxg: Arc<WithdrawFXG>) -> ChainResult<Vec<Bundle>> {
        let threshold = self.multisig_threshold_escrow();
        let hosts = self.hosts();
        let client = self.http_client.clone();
        let metrics = self.metrics.clone();

        Self::collect_with_threshold(
            hosts,
            metrics,
            "withdrawal",
            threshold,
            move |host| {
                let client = client.clone();
                let fxg = fxg.clone();
                Box::pin(async move {
                    request_sign_withdrawal_bundle(&client, host, fxg.as_ref()).await
                })
            },
            None::<fn(usize, &String, &Bundle) -> bool>,
        )
        .await
    }

    pub fn multisig_threshold_hub_ism(&self) -> usize {
        self.conf.multisig_threshold_hub_ism
    }

    pub fn multisig_threshold_escrow(&self) -> usize {
        self.conf.multisig_threshold_kaspa
    }
}

// see https://github.com/dymensionxyz/hyperlane-monorepo/blob/fe1c79156f5ef6ead5bc60f26a373d0867848532/rust/main/hyperlane-base/src/types/local_storage.rs#L80
pub async fn request_validate_new_deposits(
    client: &reqwest::Client,
    host: String,
    deposits: &DepositFXG,
) -> Result<SignedCheckpointWithMessageId> {
    info!(
        validator = %host,
        "dymension: requesting deposit sigs from validator"
    );
    let bz = Bytes::from(deposits);
    let res = client
        // calls to https://github.com/dymensionxyz/hyperlane-monorepo/blob/1a603d65e0073037da896534fc52da4332a7a7b1/rust/main/chains/dymension-kaspa/src/router.rs#L40
        .post(format!("{}{}", host, ROUTE_VALIDATE_NEW_DEPOSITS))
        .body(bz)
        .send()
        .await?;

    let status = res.status();
    if status == StatusCode::OK {
        let body = res.json::<SignedCheckpointWithMessageId>().await?;
        Ok(body)
    } else {
        let err_msg = res.text().await.unwrap_or_else(|_| status.to_string());

        let err = match status {
            StatusCode::ACCEPTED => {
                eyre::eyre!("DepositNotFinal: {}", err_msg)
            }
            StatusCode::UNPROCESSABLE_ENTITY => {
                eyre::eyre!("TransactionRejected: {}", err_msg)
            }
            StatusCode::SERVICE_UNAVAILABLE => {
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
    client: &reqwest::Client,
    host: String,
    conf: &ConfirmationFXG,
) -> Result<Signature> {
    let bz = Bytes::from(conf);
    let res = client
        .post(format!("{}{}", host, ROUTE_VALIDATE_CONFIRMED_WITHDRAWALS))
        .body(bz)
        .send()
        .await?;

    let status = res.status();
    if status == StatusCode::OK {
        let body = res.json::<Signature>().await?;
        Ok(body)
    } else {
        let err_msg = res.text().await.unwrap_or_else(|_| status.to_string());
        Err(eyre::eyre!(
            "validate confirmation: {} - {}",
            status,
            err_msg
        ))
    }
}

pub async fn request_sign_withdrawal_bundle(
    client: &reqwest::Client,
    host: String,
    fxg: &WithdrawFXG,
) -> Result<Bundle> {
    info!(
        validator = %host,
        "dymension: requesting withdrawal sigs from validator"
    );
    let bz = Bytes::try_from(fxg)?;
    let res = client
        .post(format!("{}{}", host, ROUTE_SIGN_PSKTS))
        .body(bz)
        .send()
        .await?;

    let status = res.status();
    if status == StatusCode::OK {
        let bundle = res.json::<Bundle>().await?;
        Ok(bundle)
    } else {
        let err_msg = res.text().await.unwrap_or_else(|_| status.to_string());
        Err(eyre::eyre!(
            "sign withdrawal bundle: {} - {}",
            status,
            err_msg
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kas_bridge::deposit::DepositFXG;
    use hyperlane_core::{Checkpoint, CheckpointWithMessageId, SignedType, H256, U256};

    #[tokio::test]
    #[ignore = "Requires real validator server"]
    async fn test_server_smoke() {
        let host = "http://localhost:9090";
        let deposits = DepositFXG::default();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap();
        let res = request_validate_new_deposits(&client, host.to_string(), &deposits).await;
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
