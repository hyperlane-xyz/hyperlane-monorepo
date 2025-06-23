use tonic::async_trait;

use std::collections::HashMap;

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult,
    SignedCheckpointWithMessageId, H256,
};

use bytes::Bytes;
use eyre::Result;
use reqwest::StatusCode;

use crate::ConnectionConf;

use crate::endpoints::*;
use dym_kas_core::{confirmation::ConfirmationFXG, deposit::DepositFXG};

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
        // map validator addr to sig(s)
        // TODO: in parallel
        let mut results = Vec::new();
        for (host, validator_id) in self
            .conf
            .validator_hosts
            .clone()
            .into_iter()
            .zip(self.conf.validator_ids.clone().into_iter())
        {
            //         let checkpoints = futures::future::join_all(futures).await; TODO: Parallel
            let res = request_validate_new_deposits(host, fxg).await;
            match res {
                Ok(r) => match r {
                    Some(sig) => {
                        results.push(sig);
                    }
                    None => {
                        // TODO: log
                    }
                },
                Err(_e) => {
                    // TODO: log error
                }
            }
        }
        Ok(results)
    }

    /// this runs on relayer
    pub async fn get_confirmation_sigs(
        &self,
        fxg: &ConfirmationFXG,
    ) -> ChainResult<Vec<SignedCheckpointWithMessageId>> {
        // TODO: impl, maybe need to change return type
        unimplemented!()
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

// TODO: impl confirmation sig, mimic https://github.com/dymensionxyz/dymension/blob/6dfedd4126df6fa332ef95c750d2375c65e655ce/x/kas/keeper/msg_server.go#L42-L48
