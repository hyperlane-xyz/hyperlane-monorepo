#![allow(unused)]

use async_trait::async_trait;
use solana_sdk::signature::Keypair;
use tracing::info;
use tracing::{instrument, warn};

use crate::{SuiRpcClient};
use crate::{ConnectionConf};
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, SignedType, TxOutcome, ValidatorAnnounce, H256, H512, U256,
};

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use std::str::FromStr;
use url::Url;

/// A reference to a ValidatorAnnounce contract on Sui chain
#[derive(Debug)]
pub struct SuiValidatorAnnounce {
    package_address: SuiAddress,
    sui_client: SuiRpcClient,
    payer: Option<Keypair>,
    domain: HyperlaneDomain,
}

impl SuiValidatorAnnounce {
    /// Create a new Sui ValidatorAnnounce
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, payer: Option<Keypair>) -> Self {
        let sui_client = SuiRpcClient::new(conf.url.to_string());
        let package_address =
        SuiAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        Self {
            package_address,
            sui_client,
            payer,
            domain: locator.domain.clone(),
        }
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    #[allow(unused)]
    async fn announce_contract_call(
        &self,
        announcement: SignedType<Announcement>,
        _tx_gas_limit: Option<U256>,
    ) -> Result<(String, bool)> {
        let serialized_signature: [u8; 65] = announcement.signature.into();

        let payer = self
            .payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        // fetch transaction information from the response
        let tx_hash = "".to_string();
        let has_success = false;
        Ok((tx_hash, has_success))
    }
}

impl HyperlaneContract for SuiValidatorAnnounce {
    fn address(&self) -> H256 {
        H256(self.package_address.into_bytes())
    }
}
/*
impl HyperlaneChain for SuiValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        Box::new(crate::SuiHpProvider::new(
            self.domain.clone(),
            self.aptos_client.path_prefix_string(),
        ))
    }
}
 */
#[async_trait]
impl ValidatorAnnounce for SuiValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        Ok(vec![vec!["".to_string()]])
    }

    async fn announce_tokens_needed(
        &self,
        _announcement: SignedType<Announcement>,
    ) -> Option<U256> {
        Some(U256::zero())
    }

    #[instrument(err, ret, skip(self))]
    async fn announce(
        &self,
        _announcement: SignedType<Announcement>,
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        info!(
            "Announcing Sui Validator _announcement ={:?}",
            _announcement
        );
        Ok(TxOutcome {
            transaction_id: H512::zero(),
            executed: false,
            gas_used: U256::zero(),
            gas_price: U256::zero().try_into()?,
        })
    }
}
