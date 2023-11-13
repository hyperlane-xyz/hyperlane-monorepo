use anyhow::{bail, Result};
use ethers::{
    abi::AbiDecode,
    middleware::SignerMiddleware,
    providers::Middleware,
    signers::{LocalWallet, Signer},
    types::{Address, Bytes, U256},
};

use std::sync::Arc;

use crate::{
    models::*,
    utils::{MAILBOX, PROVIDER},
};

#[derive(Debug, Default)]
pub struct Sender;
impl Sender {
    /// Sends a message via the Hyperlane protocol
    ///
    /// # Arguments
    /// * `key` - The wallet key used for signing the transaction
    /// * `domain_id` - The destination chain ID
    /// * `receiver` - The receiver's address in bytes
    /// * `message` - The message to be sent
    /// * `igp` - The address of the Interchain Gas Paymaster
    pub async fn dispatch_message(
        key: LocalWallet,
        domain_id: u32,
        receiver: [u8; 32],
        message: Bytes,
        igp: Address,
    ) -> Result<()> {
        // Fetch the address corresponding to the wallet key
        let address = key.address();

        // Check if both provider and mailbox are initialized
        if let (Some(provider), Some(mailbox)) = (PROVIDER.get(), MAILBOX.get()) {
            // Retrieve the current chain ID and create a client
            let this_chain_id = provider.get_chainid().await?.as_u32();
            let client = SignerMiddleware::new(provider, key.with_chain_id(this_chain_id));

            // Initialize the paymaster and mailbox contracts
            let igp = Paymaster::new(igp, Arc::new(client.clone()));
            let mailbox_contract = Mailbox::new(*mailbox, Arc::new(client));

            // Inform the user that the message dispatch is starting
            println!(
                "\nSending message from Origin Chain {} to Destination Chain {}...",
                this_chain_id, domain_id
            );

            // Attempt to dispatch the message
            if let Some(message_tx) = mailbox_contract
                .dispatch(domain_id, receiver, message)
                .send()
                .await?
                .await?
            {
                // Extract and display the message ID
                let mref = &message_tx.logs[1].topics[1];
                println!("\nMessage ID: {:#?}", mref);
                let explorer_link = format!("https://explorer.hyperlane.xyz/message/{:#?}", mref);
                let message_id = AbiDecode::decode(message_tx.logs[1].topics[1])?;

                // Pay for the interchain gas and inform the user
                println!("\nPaying for interchain gas...");
                igp.pay_for_gas(message_id, domain_id, U256::from(150000), address)
                    .value(U256::from(15000000000000000u64))
                    .send()
                    .await?
                    .await?;

                // Confirm message dispatch
                println!("\nMessage successfully sent!");
                println!("\n{explorer_link:#?}\n");
            } else {
                // Handle dispatch failure
                bail!("Failed to dispatch the message. Please check the provided details.");
            }
        } else {
            // Handle initialization failure
            bail!(
                "Provider or Mailbox is not properly initialized. Please check the configuration."
            );
        }
        Ok(())
    }
}
