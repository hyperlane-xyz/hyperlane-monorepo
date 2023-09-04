#![allow(unused)]

use async_trait::async_trait;
use tracing::info;
use tracing::{instrument, warn};

use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, SignedType, TxOutcome, ValidatorAnnounce, H256, H512,
    U256,
};
use crate::{ConnectionConf};
use crate::AptosClient;
use crate::utils::send_aptos_transaction;

use aptos_sdk::{
  transaction_builder::TransactionFactory,
  types::{
    account_address::AccountAddress, 
    chain_id::ChainId,
    transaction::{ EntryFunction, TransactionPayload }
  },
  move_types::{
    ident_str,
    language_storage::{ModuleId},
  },
  rest_client::{
    Client, FaucetClient,
    aptos_api_types::{ViewRequest, EntryFunctionId}
  },
  types::LocalAccount,
  types::AccountKey,
  crypto::ed25519::Ed25519PrivateKey
};

use once_cell::sync::Lazy;
use anyhow::{Context, Result};
use url::Url;
use std::str::FromStr;

/// A reference to a ValidatorAnnounce contract on Aptos chain
#[derive(Debug)]
pub struct AptosValidatorAnnounce {
    package_address: AccountAddress,
    aptos_client: AptosClient,
    domain: HyperlaneDomain,
}

impl AptosValidatorAnnounce {
    /// Create a new Sealevel ValidatorAnnounce
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> Self {
        let aptos_client = AptosClient::new(conf.url.to_string());
        let package_address = AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        Self {
            package_address,
            aptos_client,
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
    
        let account_address = AccountAddress::from_hex_literal("0x1764fd45317bbddc6379f22c6c72b52a138bf0e2db76297e81146cacf7bc42c5").unwrap();
        let mut alice = LocalAccount::new(
          account_address,
          AccountKey::from_private_key(
            Ed25519PrivateKey::try_from(
              hex::decode("b8ab39c741f23066ee8015ff5248e5720cfb31648b13fb643ceae287b6c50520").unwrap().as_slice()
            ).unwrap()),
          self.aptos_client.get_account(account_address).await?.into_inner().sequence_number
        );
        

        let _entry = EntryFunction::new(
          ModuleId::new(
            self.package_address,
            ident_str!("validator_announce").to_owned()
          ),
          ident_str!("announce").to_owned(),
          vec![],
          vec![
            bcs::to_bytes(&AccountAddress::from_hex_literal(
                &format!("0x{}", hex::encode(announcement.value.validator.as_bytes()))
              ).unwrap()
            ).unwrap(),
            bcs::to_bytes(&serialized_signature.to_vec()).unwrap(),
            bcs::to_bytes(&announcement.value.storage_location).unwrap()
          ]
        );

        let payload = TransactionPayload::EntryFunction(_entry);
        let response = send_aptos_transaction(
          &self.aptos_client,
          &mut alice,
          payload.clone()
        ).await?;

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
        Box::new(crate::SealevelProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl ValidatorAnnounce for AptosValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let validator_addresses: Vec<serde_json::Value> = 
          validators.iter().map(|v| {
            serde_json::Value::String(
              AccountAddress::from_bytes(v.as_bytes()).unwrap().to_hex_literal()
            )
          }).collect();

        let view_response = self.aptos_client.view(
          &ViewRequest {
            function: EntryFunctionId::from_str(
              &format!(
                "{}::validator_announce::get_announced_storage_locations", 
                self.package_address.to_hex_literal()
              )
            ).unwrap(),
            type_arguments: vec![],
            arguments: vec![
              serde_json::Value::Array(validator_addresses),
            ]
          },
          Option::None
        )
        .await
        .map_err(ChainCommunicationError::from_other)?;
  
        let view_result = serde_json::from_str::<Vec<Vec<String>>>(&view_response.inner()[0].to_string());

        Ok(view_result.unwrap())
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
        info!("Announcing Aptos Validator _announcement ={:?}", _announcement);

        let (tx_hash, is_success) = self
          .announce_contract_call(_announcement, _tx_gas_limit)
          .await
          .map_err(|e| { println!("tx error {}", e.to_string()); ChainCommunicationError::TransactionTimeout() })?;

        Ok(TxOutcome {
          transaction_id: H512::from(H256::from_str(&tx_hash).unwrap()),
          executed: is_success,
          gas_used: U256::zero(),
          gas_price: U256::zero(),
        })
    }
}
