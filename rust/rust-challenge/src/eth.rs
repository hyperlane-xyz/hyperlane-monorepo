use std::fmt::Display;
use std::str::FromStr;
use std::sync::Arc;

use ethers_contract::Contract;
use ethers_core::abi::{Abi, Token};
use ethers_core::types::{Address, TransactionRequest, H256, U256};
use ethers_core::types::{Bytes, NameOrAddress};
use ethers_core::utils::keccak256;
use ethers_core::utils::parse_ether;
use ethers_middleware::SignerMiddleware;
use ethers_providers::{Http, Middleware, Provider};
use ethers_signers::{LocalWallet, Signer};
use serde::{Deserialize, Serialize};
use serde_json::error;
use thiserror::Error;
use url::Url;

use crate::chain::Chain;

pub use ethers_core::types::TransactionReceipt;

#[derive(Debug, Clone)]
pub struct EthClient {
    /// A base provider for interacting with the Ethereum network
    provider: Provider<Http>,
    /// The chain id for the configured chain
    chain_id: u32,
    /// An optional signer for signing transactions
    signer: Option<LocalWallet>,
}

// Note: that we're using TryFrom<Chain> for EthClient, which is a bit of a code smell.
//  Basically, we've gaurenteed that we can only use the EthClient with the chains that we've implemented.
//   If this were to support user configurable chains, we'd need to do something different.
impl TryFrom<Chain> for EthClient {
    type Error = EthClientError;
    fn try_from(chain: Chain) -> Result<Self, Self::Error> {
        let rpc_url = chain.rpc_url();
        let provider = Provider::<Http>::try_from(rpc_url.to_string())
            .map_err(|e| EthClientError::Default(e.into()))?;
        let chain_id = chain.chain_id();
        Ok(Self {
            provider,
            chain_id,
            signer: None,
        })
    }
}

impl EthClient {
    /// Attach a signer to the client if required by the workflow
    pub fn with_signer(&mut self, private_key: String) -> Result<(), EthClientError> {
        let wallet = LocalWallet::from_str(&private_key)
            .map_err(|e| EthClientError::Default(e.into()))?
            .with_chain_id(self.chain_id);
        self.signer = Some(wallet);
        Ok(())
    }

    // TODO: make errors more specific
    /// Call dispatch on the specified contract:
    ///    function dispatch(
    ///        uint32 destinationDomain,
    ///        bytes32 recipientAddress,
    ///        bytes calldata messageBody
    ///    ) external payable returns (bytes32 messageId);
    /// # Arguments
    /// * `contract_address` - The address of the contract to call
    /// * `destination_domain` - The chain id of the destination chain
    /// * `recipient_address` - The address of the recipient on the destination chain
    /// * `message_body` - The message body to send
    pub async fn dispatch(
        &self,
        contract_address: Address,
        destination_domain: u32,
        recipient_address: Address,
        message_body: Vec<u8>,
    ) -> Result<TransactionReceipt, EthClientError> {
        // Attempt to get the signer, if it's not there, return an error
        let signer = self
            .signer
            .as_ref()
            .ok_or(EthClientError::MissingPrivateKey)?;

        // The minimal ABI for the contract dispatch method -- let's not get too fancy here
        // Parse the abi representation of dispatch
        let abi_str = r#"[{"inputs":[{"internalType":"uint32","name":"destinationDomain","type":"uint32"},{"internalType":"bytes32","name":"recipientAddress","type":"bytes32"},{"internalType":"bytes","name":"messageBody","type":"bytes"}],"name":"dispatch","outputs":[{"internalType":"bytes32","name":"messageId","type":"bytes32"}],"stateMutability":"payable","type":"function"}]"#;
        let abi: Abi =
            serde_json::from_str(abi_str).map_err(|e| EthClientError::Default(e.into()))?;

        // Wrap the provider and signer into SignerMiddleware for the contract
        let client = Arc::new(SignerMiddleware::new(self.provider.clone(), signer.clone()));

        // Create the contract instance with all of our components
        let contract = Contract::new(contract_address, abi, client);

        // Encode params for the method call
        let destination_domain = Token::Uint(U256::from(destination_domain));
        // Convert the address to bytes -- write within a 32 byte buffer
        let mut recipient_address_buffer = [0u8; 32];
        recipient_address_buffer[..recipient_address.0.len()]
            .copy_from_slice(&recipient_address.as_bytes());
        let recipient_address = Token::FixedBytes(recipient_address_buffer.to_vec());
        let message_body = Token::Bytes(message_body);

        // Encode the transaction
        let tx = contract
            .method::<_, H256>(
                "dispatch",
                (destination_domain, recipient_address, message_body),
            )
            .map_err(|e| EthClientError::Default(e.into()))?
            // TODO: fix this super janky gas parameterization
            .value(parse_ether("0.01").unwrap())
            .gas(1000000)
            .gas_price(1_000_000_000);

        // Send the transaction
        let pending_tx = tx
            .send()
            .await
            .map_err(|e| EthClientError::Default(e.into()))?;

        // Wait for the transaction to be mined
        let receipt = pending_tx
            .confirmations(1)
            .await
            .map_err(|e| EthClientError::Default(e.into()))?;

        match receipt {
            Some(receipt) => Ok(receipt),
            None => Err(EthClientError::MissingReceipt),
        }
    }
}

// TODO: flesh out
#[derive(thiserror::Error, Debug)]
pub enum EthClientError {
    #[error("default error: {0}")]
    Default(anyhow::Error),
    #[error("provider error: {0}")]
    Proverr(#[from] ethers_providers::ProviderError),
    #[error("missing private key")]
    MissingPrivateKey,
    #[error("missing recipet")]
    MissingReceipt,
}
