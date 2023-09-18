// !TODO
#![allow(unused)]

use async_trait::async_trait;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H256,
};
use solana_sdk::{
    signature::Keypair,
};

use crate::{
    ConnectionConf, AptosHpProvider,
};
use serde::{Serialize, Deserialize};

use crate::AptosClient;

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
    aptos_api_types::{ViewRequest, EntryFunctionId, VersionedEvent}
  },
  types::LocalAccount,
  types::AccountKey,
  crypto::ed25519::Ed25519PrivateKey
};

use std::str::FromStr;
use crate::utils::convert_addr_string_to_h256;
/// A reference to a MultisigIsm contract on some Sealevel chain
#[derive(Debug)]
pub struct AptosMultisigISM {
    payer: Option<Keypair>,
    domain: HyperlaneDomain,

    aptos_client: AptosClient,
    package_address: AccountAddress,
}

impl AptosMultisigISM {
    /// Create a new Sealevel MultisigIsm.
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, payer: Option<Keypair>) -> Self {

        let package_address = AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let aptos_client = AptosClient::new(conf.url.to_string());

        Self {
            payer,
            domain: locator.domain.clone(),
            aptos_client,
            package_address
        }
    }
}

impl HyperlaneContract for AptosMultisigISM {
    fn address(&self) -> H256 {
        self.package_address.into_bytes().into()
    }
}

impl HyperlaneChain for AptosMultisigISM {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(AptosHpProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl MultisigIsm for AptosMultisigISM {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let view_response = self.aptos_client.view(
          &ViewRequest {
            function: EntryFunctionId::from_str(
              &format!(
                "{}::multisig_ism::validators_and_threshold", 
                self.package_address.to_hex_literal()
              )
            ).unwrap(),
            type_arguments: vec![],
            arguments: vec![
              serde_json::json!(message.origin)
            ]
          },
          Option::None
        )
        .await
        .map_err(ChainCommunicationError::from_other)?;
        
        let validators: Vec<H256> = serde_json::from_str::<Vec<String>>(&view_response.inner()[0].to_string())
          .unwrap()
          .iter()
          .map(|v| convert_addr_string_to_h256(v).unwrap())
          .collect();
        let threshold = serde_json::from_str::<String>(&view_response.inner()[1].to_string())
          .unwrap()
          .parse::<u8>()
          .unwrap();

        Ok((validators, threshold))
    }
}