use std::str::FromStr;
use std::sync::Arc;

use ethers_contract::{Contract, EthEvent};
use ethers_core::abi::{Abi, Token};
use ethers_core::types::{Address, Bytes, H256, U256};

use ethers_core::utils::parse_ether;
use ethers_middleware::SignerMiddleware;
use ethers_providers::{Http, Provider};
use ethers_signers::{LocalWallet, Signer};
use futures::StreamExt;
use hyperlane_core::HyperlaneMessage;

use crate::chain::Chain;
use crate::matching_list::MatchingList;
use lazy_static::lazy_static;

pub use ethers_core::types::TransactionReceipt;

// TODO: this should reference an ABI file
lazy_static! {
    static ref ABI_STRING: String = r#"[{"inputs":[{"internalType":"uint32","name":"destinationDomain","type":"uint32"},{"internalType":"bytes32","name":"recipientAddress","type":"bytes32"},{"internalType":"bytes","name":"messageBody","type":"bytes"}],"name":"dispatch","outputs":[{"internalType":"bytes32","name":"messageId","type":"bytes32"}],"stateMutability":"payable","type":"function"}]"#.to_string();
}

#[derive(Clone, Debug, EthEvent)]
struct Dispatch {
    #[ethevent(indexed)]
    sender: Address,
    #[ethevent(indexed)]
    destination: u32,
    #[ethevent(indexed)]
    recipient: H256,
    message: Bytes,
}

#[derive(Debug, Clone)]
pub struct RpcClient {
    /// A base provider for interacting with the Rpcereum network
    provider: Provider<Http>,
    /// The chain id for the configured chain
    chain_id: u32,
    /// An optional signer for signing transactions
    signer: Option<LocalWallet>,
}

// Note: that we're using TryFrom<Chain> for RpcClient, which is a bit of a code smell.
//  Basically, we've gaurenteed that we can only use the RpcClient with the chains that we've implemented.
//   If this were to support user configurable chains, we'd need to do something different.
impl TryFrom<Chain> for RpcClient {
    type Error = RpcClientError;
    fn try_from(chain: Chain) -> Result<Self, Self::Error> {
        let rpc_url = chain.rpc_url();
        let provider = Provider::<Http>::try_from(rpc_url.to_string())
            .map_err(|e| RpcClientError::Default(e.into()))?;
        let chain_id = chain.chain_id();
        Ok(Self {
            provider,
            chain_id,
            signer: None,
        })
    }
}

impl RpcClient {
    /// Attach a signer to the client if required by the workflow
    pub fn with_signer(&mut self, private_key: String) -> Result<(), RpcClientError> {
        let wallet = LocalWallet::from_str(&private_key)
            .map_err(RpcClientError::Wallet)?
            .with_chain_id(self.chain_id);
        self.signer = Some(wallet);
        Ok(())
    }

    /// Call dispatch on a Mailbox to dispatch a message to the destination chain and recipient
    /// # Arguments
    /// * `contract_address` - The address of the contract to call
    /// * `destination_domain` - The chain id of the destination chain
    /// * `recipient_address` - The address of the recipient on the destination chain
    /// * `message_body` - The message body to send
    /// # Returns
    /// A TransactionReceipt
    pub async fn send(
        &self,
        mailbox_address: Address,
        destination_domain: u32,
        recipient_address: Address,
        message_body: Vec<u8>,
    ) -> Result<TransactionReceipt, RpcClientError> {
        // Attempt to get the signer, if it's not there, return an error
        let signer = self
            .signer
            .as_ref()
            .ok_or(RpcClientError::MissingPrivateKey)?;

        // The minimal ABI for the contract dispatch method -- let's not get too fancy here
        // Parse the abi representation of dispatch
        // unwrap is ok :thumbsup
        let abi: Abi = serde_json::from_str(&ABI_STRING).unwrap();

        // Wrap the provider and signer into SignerMiddleware for the contract
        let client = Arc::new(SignerMiddleware::new(self.provider.clone(), signer.clone()));

        // Create the contract instance with all of our components -- including a proper signer
        let contract = Contract::new(mailbox_address, abi, client);

        // Encode params for the method call
        let destination_domain = Token::Uint(U256::from(destination_domain));
        // Convert the address to bytes -- write within a 32 byte buffer
        let mut recipient_address_buffer = [0u8; 32];
        recipient_address_buffer[..recipient_address.0.len()]
            .copy_from_slice(recipient_address.as_bytes());
        let recipient_address = Token::FixedBytes(recipient_address_buffer.to_vec());
        let message_body = Token::Bytes(message_body);

        // Encode the transaction
        let tx = contract
            .method::<_, H256>(
                "dispatch",
                (destination_domain, recipient_address, message_body),
            )
            .map_err(|e| RpcClientError::Default(e.into()))?
            // TODO: I should really fix this with proper gas estimation
            //  But for now, this is fine for testnet
            //   Also -- this unwrap is fine
            .value(parse_ether("0.01").unwrap())
            .gas(1000000)
            .gas_price(1_000_000_000);

        // Send the transaction
        let pending_tx = tx
            .send()
            .await
            .map_err(|e| RpcClientError::Default(e.into()))?;

        // Wait for the transaction to be mined
        let receipt = pending_tx
            .confirmations(1)
            .await
            .map_err(RpcClientError::Provider)?;

        match receipt {
            Some(receipt) => Ok(receipt),
            None => Err(RpcClientError::MissingReceipt),
        }
    }

    /// Listen for messages being sent through a Mailbox againt a MatchingList
    /// # Arguments
    /// * `mailbox_address` - The address of the mailbox contract
    /// * `matching_list` - The matching list to check against
    /// * `callback` - A callback to call when a message is matched
    /// # Returns
    /// A stream of events that match the matching list
    pub async fn listen(
        &self,
        mailbox_address: Address,
        matching_list: MatchingList,
        callback: impl Fn(HyperlaneMessage) + Send + Sync + 'static,
    ) -> Result<(), RpcClientError> {
        // The minimal ABI for the contract dispatch method -- let's not get too fancy here
        // Parse the abi representation of dispatch
        // unwrap is ok :thumbsup
        let abi: Abi = serde_json::from_str(&ABI_STRING).unwrap();
        // Wrap the provider and signer into SignerMiddleware for the contract
        let client = Arc::new(self.provider.clone());
        // Create the contract instance with all of our components -- including a proper signer
        let contract = Contract::new(mailbox_address, abi, client);

        // Listen for `Dispatch` events
        let event = contract.event::<Dispatch>();
        let mut event_stream = event
            .stream()
            .await
            .map_err(|e| RpcClientError::Default(e.into()))?;

        // OK just listen for events and log them out
        while let Some(log) = event_stream.next().await {
            let log = log.map_err(|e| RpcClientError::Default(e.into()))?;
            // NOTE: this is not a super nice way to do this.
            //  I would like to just listen for these events as HyperlanaMessages,
            //   but I'm divereged on the ethers versions and I'd have to rewrite too much
            //    code to get it to work.
            // NOTE: I don't understand the rational behind interprettiing an
            //  `Address` as a `H256` here. For now this stops the listen
            //    panicking, but this is not a valid solution
            let mut sender_as_h256_bytes = [0u8; 32];
            sender_as_h256_bytes[..log.sender.0.len()].copy_from_slice(log.sender.as_bytes());
            let hyperlane_message = HyperlaneMessage {
                // Let's just hardcode these for now
                version: 3,
                nonce: 0,

                // Get the remaining values from the log + client
                origin: self.chain_id,
                sender: hyperlane_core::H256::from_slice(&sender_as_h256_bytes),
                destination: log.destination,
                recipient: hyperlane_core::H256::from_slice(log.recipient.as_bytes()),
                body: log.message.to_vec(),
            };
            if matching_list.msg_matches(&hyperlane_message, false) {
                callback(hyperlane_message);
            }
        }

        Ok(())
    }
}

#[derive(thiserror::Error, Debug)]
pub enum RpcClientError {
    // Get out of jail free
    #[error("default error: {0}")]
    Default(#[from] anyhow::Error),
    #[error("provider error: {0}")]
    Provider(#[from] ethers_providers::ProviderError),
    #[error("abi error: {0}")]
    Abi(#[from] ethers_core::abi::Error),
    #[error("missing private key")]
    MissingPrivateKey,
    #[error("missing recipet")]
    MissingReceipt,
    #[error("wallet error: {0}")]
    Wallet(#[from] ethers_signers::WalletError),
}
