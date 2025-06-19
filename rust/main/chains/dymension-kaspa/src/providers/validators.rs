use std::future::Future;
use std::time::Instant;

use tonic::async_trait;

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, FixedPointNumber, H512,
    U256,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use url::Url;

use crate::{ConnectionConf, HyperlaneKaspaError, Signer};

pub use dym_kas_core::api::deposits::*;
use dym_kas_core::deposit::DepositFXG;
use dym_kas_relayer::client_validator::client::validate_new_deposits;

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

    pub async fn validate_deposits(&self, fxg: &DepositFXG) -> ChainResult<Vec<bool>> {
        // TODO: in parallel
        let mut results = Vec::new();
        for host in self.conf.validator_hosts {
            let res = validate_new_deposits(host, fxg).await;
            match res {
                Ok(r) => results.push(r),
                Err(e) => {
                    results.push(false);
                }
            }
        }
        Ok(results)
    }
}
