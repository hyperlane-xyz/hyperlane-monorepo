#![allow(unused)]

use aptos_sdk::crypto::ed25519::Ed25519PublicKey;
use aptos_sdk::types::transaction::authenticator::AuthenticationKey;
use async_trait::async_trait;
use solana_sdk::signature::Keypair;
use tracing::info;
use tracing::{instrument, warn};

use crate::utils::{self, send_aptos_transaction};
use crate::{convert_hex_string_to_h256, convert_keypair_to_aptos_account, AptosClient};
use crate::{simulate_aptos_transaction, ConnectionConf};
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, SignedType, TxOutcome, ValidatorAnnounce, H256, H512, U256,
};

use aptos_sdk::{
    crypto::ed25519::Ed25519PrivateKey,
    move_types::{ident_str, language_storage::ModuleId},
    rest_client::{
        aptos_api_types::{EntryFunctionId, ViewRequest},
        Client, FaucetClient,
    },
    transaction_builder::TransactionFactory,
    types::AccountKey,
    types::LocalAccount,
    types::{
        account_address::AccountAddress,
        chain_id::ChainId,
        transaction::{EntryFunction, TransactionPayload},
    },
};

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use std::str::FromStr;
use url::Url;

/// A reference to a ValidatorAnnounce contract on Aptos chain
#[derive(Debug)]
pub struct AptosValidatorAnnounce {
    package_address: AccountAddress,
    aptos_client: AptosClient,
    payer: Option<Keypair>,
    domain: HyperlaneDomain,
}

impl AptosValidatorAnnounce {
    /// Create a new Aptos ValidatorAnnounce
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, payer: Option<Keypair>) -> Self {
        let aptos_client = AptosClient::new(conf.url.to_string());
        let package_address =
            AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        Self {
            package_address,
            aptos_client,
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

        let mut signer_account = convert_keypair_to_aptos_account(&self.aptos_client, payer).await;

        let payload = utils::make_aptos_payload(
            self.package_address,
            "validator_announce",
            "announce",
            vec![],
            vec![
                bcs::to_bytes(
                    &AccountAddress::from_hex_literal(&format!(
                        "0x{}",
                        hex::encode(announcement.value.validator.as_bytes())
                    ))
                    .unwrap(),
                )
                .unwrap(),
                bcs::to_bytes(&serialized_signature.to_vec()).unwrap(),
                bcs::to_bytes(&announcement.value.storage_location).unwrap(),
            ],
        );

        let response =
            send_aptos_transaction(&self.aptos_client, &mut signer_account, payload.clone())
                .await?;

        // fetch transaction information from the response
        let tx_hash = response.transaction_info().unwrap().hash.to_string();
        let has_success = response.success();
        Ok((tx_hash, has_success))
    }
}

impl HyperlaneContract for AptosValidatorAnnounce {
    fn address(&self) -> H256 {
        H256(self.package_address.into_bytes())
    }
}

impl HyperlaneChain for AptosValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        Box::new(crate::AptosHpProvider::new(
            self.domain.clone(),
            self.aptos_client.path_prefix_string(),
        ))
    }
}

#[async_trait]
impl ValidatorAnnounce for AptosValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let validator_addresses: Vec<serde_json::Value> = validators
            .iter()
            .map(|v| {
                serde_json::Value::String(
                    AccountAddress::from_bytes(v.as_bytes())
                        .unwrap()
                        .to_hex_literal(),
                )
            })
            .collect();

        let view_response = utils::send_view_request(
            &self.aptos_client,
            self.package_address.to_hex_literal(),
            "validator_announce".to_string(),
            "get_announced_storage_locations".to_string(),
            vec![],
            vec![serde_json::Value::Array(validator_addresses)],
        )
        .await?;

        let view_result = serde_json::from_str::<Vec<Vec<String>>>(&view_response[0].to_string());
        let mut view_result = view_result.unwrap();
        if view_result.len() == 0 {
            view_result.push(vec![]);
        }
        Ok(view_result)
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
            "Announcing Aptos Validator _announcement ={:?}",
            _announcement
        );

        let (tx_hash, is_success) = self
            .announce_contract_call(_announcement, _tx_gas_limit)
            .await
            .map_err(|e| {
                println!("tx error {}", e.to_string());
                ChainCommunicationError::TransactionTimeout()
            })?;

        Ok(TxOutcome {
            transaction_id: H512::from(convert_hex_string_to_h256(&tx_hash).unwrap()),
            executed: is_success,
            gas_used: U256::zero(),
            gas_price: U256::zero(),
        })
    }
}
