use async_trait::async_trait;
use tracing::{info, instrument, warn};

use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, H512,
    U256,
};
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey};

use crate::{ConnectionConf, RpcClientWithDebug};
use hyperlane_sealevel_validator_announce::{
    accounts::ValidatorStorageLocationsAccount, validator_storage_locations_pda_seeds,
};

// use aptos_sdk::crypto::ed25519::Ed25519PrivateKey;
use aptos_sdk::transaction_builder::TransactionFactory;
use aptos_types::{
  account_address::AccountAddress, 
  transaction::EntryFunction
};
use aptos_types::transaction::{ TransactionPayload };
use move_core_types::{
  ident_str,
  language_storage::{ModuleId},
};
use aptos::common::utils;
use aptos_sdk::{
    rest_client::{Client, FaucetClient},
    types::LocalAccount,
};
use once_cell::sync::Lazy;
use anyhow::{Context, Result};
use url::Url;
use std::str::FromStr;

/// A reference to a ValidatorAnnounce contract on Aptos chain
#[derive(Debug)]
pub struct AptosValidatorAnnounce {
    program_id: Pubkey,
    rpc_client: RpcClientWithDebug,
    domain: HyperlaneDomain,
}

impl AptosValidatorAnnounce {
    /// Create a new Sealevel ValidatorAnnounce
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> Self {
        let rpc_client = RpcClientWithDebug::new(conf.url.to_string());
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            program_id,
            rpc_client,
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
    ) -> Result<()> {
        let serialized_signature: [u8; 65] = announcement.signature.into();
        
        static NODE_URL: Lazy<Url> = Lazy::new(|| {
          Url::from_str("https://fullnode.devnet.aptoslabs.com").unwrap()
        });
      
        static FAUCET_URL: Lazy<Url> = Lazy::new(|| {
            Url::from_str("https://faucet.devnet.aptoslabs.com").unwrap()
        });

        let rest_client = Client::new(NODE_URL.clone());
        let faucet_client = FaucetClient::new(FAUCET_URL.clone(), NODE_URL.clone()); // <:!:section_1a
        let mut alice = LocalAccount::generate(&mut rand::rngs::OsRng);

        faucet_client
          .fund(alice.address(), 100_000_000)
          .await
          .context("Failed to fund Alice's account")?;

        let contract_address: &str = "0x61ad49767d3dd5d5e6e41563c3ca3e8600c52c350ca66014ee7f6874f28f5ddb";
        let _entry = EntryFunction::new(
          ModuleId::new(
            AccountAddress::from_hex_literal(contract_address).unwrap(),
            ident_str!("validator_announce").to_owned()
          ),
          ident_str!("announce").to_owned(),
          vec![],
          vec![
            bcs::to_bytes(&announcement.value.validator).unwrap(),
            serialized_signature.to_vec(),
            bcs::to_bytes(&announcement.value.storage_location).unwrap()
          ]
        );

        let payload = TransactionPayload::EntryFunction(_entry);
        
        const GAS_LIMIT: u64 = 100000;
        
        let transaction_factory = TransactionFactory::new(utils::chain_id(&rest_client).await?)
                .with_gas_unit_price(100)
                .with_max_gas_amount(GAS_LIMIT);
        
        let signed_tx = alice.sign_with_transaction_builder(transaction_factory.payload(payload));
        let response = rest_client.submit_and_wait(&signed_tx).await?;
        println!("response {:?}", response);
        Ok(())
    }
}

impl HyperlaneContract for AptosValidatorAnnounce {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
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
        info!(program_id=?self.program_id, validators=?validators, "Getting validator storage locations");

        // Get the validator storage location PDAs for each validator.
        let account_pubkeys: Vec<Pubkey> = validators
            .iter()
            .map(|v| {
                let (key, _bump) = Pubkey::find_program_address(
                    // The seed is based off the H160 representation of the validator address.
                    validator_storage_locations_pda_seeds!(H160::from_slice(&v.as_bytes()[12..])),
                    &self.program_id,
                );
                key
            })
            .collect();

        // Get all validator storage location accounts.
        // If an account doesn't exist, it will be returned as None.
        let accounts = self
            .rpc_client
            .get_multiple_accounts_with_commitment(&account_pubkeys, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value;

        // Parse the storage locations from each account.
        // If a validator's account doesn't exist, its storage locations will
        // be returned as an empty list.
        let storage_locations: Vec<Vec<String>> = accounts
            .into_iter()
            .map(|account| {
                account
                    .map(|account| {
                        match ValidatorStorageLocationsAccount::fetch(&mut &account.data[..]) {
                            Ok(v) => v.into_inner().storage_locations,
                            Err(err) => {
                                // If there's an error parsing the account, gracefully return an empty list
                                info!(?account, ?err, "Unable to parse validator announce account");
                                vec![]
                            }
                        }
                    })
                    .unwrap_or_default()
            })
            .collect();

        Ok(storage_locations)
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
        warn!(
            "Announcing validator storage locations within the agents is not supported on Sealevel"
        );
        Ok(TxOutcome {
            transaction_id: H512::zero(),
            executed: false,
            gas_used: U256::zero(),
            gas_price: U256::zero(),
        })
    }
}
