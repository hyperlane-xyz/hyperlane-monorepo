use std::future::Future;
use std::time::Instant;

use tonic::async_trait;

use std::collections::HashMap;

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, FixedPointNumber,
    SignedCheckpointWithMessageId, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};

use axum::http::StatusCode;
use bytes::Bytes;
use eyre::Result;

use url::Url;

use crate::{ConnectionConf, HyperlaneKaspaError, Signer};

use crate::endpoints::*;
pub use dym_kas_core::api::deposits::*;
use dym_kas_core::deposit::DepositFXG;

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
    pub async fn validate_deposits(
        &self,
        fxg: &DepositFXG,
    ) -> ChainResult<HashMap<H256, Vec<SignedCheckpointWithMessageId>>> {
        // TODO: in parallel
        let mut results = Vec::new();
        for host in self.conf.validator_hosts.clone().into_iter() {
            let res = validate_new_deposits(host, fxg).await;
            match res {
                Ok(r) => results.push(r),
                Err(_e) => {
                    results.push(false);
                }
            }
        }
        Ok(results)
    }
}

pub async fn validate_new_deposits(
    host: String,
    deposits: &DepositFXG,
) -> Result<HashMap<H256, Vec<SignedCheckpointWithMessageId>>> {
    let bz = Bytes::from(deposits);
    let c = reqwest::Client::new();
    let res = c
        .post(format!("{}{}", host, ROUTE_VALIDATE_NEW_DEPOSITS))
        .body(bz)
        .send()
        .await?;

    // TODO: need to return sigs here
    let status = res.status();
    if status == StatusCode::OK {
        Ok(true)
    } else {
        Ok(false)
    }
}
