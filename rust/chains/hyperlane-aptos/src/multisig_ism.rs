// !TODO
#![allow(unused)]

use async_trait::async_trait;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H256,
};
use solana_sdk::signature::Keypair;

use crate::{AptosHpProvider, ConnectionConf};
use serde::{Deserialize, Serialize};

use crate::utils;
use crate::AptosClient;

use aptos_sdk::{
    crypto::ed25519::Ed25519PrivateKey,
    move_types::{ident_str, language_storage::ModuleId},
    rest_client::{
        aptos_api_types::{EntryFunctionId, VersionedEvent, ViewRequest},
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

use std::str::FromStr;
/// A reference to a MultisigIsm contract on some Aptos chain
#[derive(Debug)]
pub struct AptosMultisigISM {
    payer: Option<Keypair>,
    domain: HyperlaneDomain,

    aptos_client: AptosClient,
    package_address: AccountAddress,
}

impl AptosMultisigISM {
    /// Create a new Aptos MultisigIsm.
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, payer: Option<Keypair>) -> Self {
        let package_address =
            AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let aptos_client = AptosClient::new(conf.url.to_string());

        Self {
            payer,
            domain: locator.domain.clone(),
            aptos_client,
            package_address,
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
        Box::new(AptosHpProvider::new(
            self.domain.clone(),
            self.aptos_client.path_prefix_string(),
        ))
    }
}

#[async_trait]
impl MultisigIsm for AptosMultisigISM {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let view_response = utils::send_view_request(
            &self.aptos_client,
            self.package_address.to_hex_literal(),
            "multisig_ism".to_string(),
            "validators_and_threshold".to_string(),
            vec![],
            vec![serde_json::json!(message.origin)],
        )
        .await?;
        let validators: Vec<H256> =
            serde_json::from_str::<Vec<String>>(&view_response[0].to_string())
                .unwrap()
                .iter()
                .map(|v| utils::convert_hex_string_to_h256(v).unwrap())
                .collect();
        let threshold = serde_json::from_str::<String>(&view_response[1].to_string())
            .unwrap()
            .parse::<u8>()
            .unwrap();
        Ok((validators, threshold))
    }
}
