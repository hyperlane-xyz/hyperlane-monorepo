use clap::Args;
use ethers::prelude::*;
use ethers::providers::{Http, Provider};
use eyre::Result;
use hyperlane_core::{HyperlaneMessage, H160, H256};
use hyperlane_ethereum::interfaces::mailbox::Mailbox;
use std::str::FromStr;
use std::sync::Arc;

#[derive(Args)]
pub struct SendArgs {
    #[clap(short, long)]
    origin_domain: u32,
    #[clap(short, long)]
    mailbox: String,
    #[clap(short, long)]
    rpc: String,
    #[clap(short = 'd', long)]
    destination_domain: u32,
    #[clap(short = 'a', long)]
    destination_address: String,
    #[clap(long)]
    msg: String,
    #[clap(short, long)]
    private_key: String,
}

impl SendArgs {
    pub async fn send_message(self) -> Result<()> {
        // Connect to provider
        let provider = Provider::<Http>::try_from(self.rpc)?;
        let chain_id = provider.get_chainid().await?;
        let wallet = Wallet::from_str(&self.private_key)?.with_chain_id(chain_id.as_u64());

        // Wrap the wallet in a SignerMiddleware
        let client = Arc::new(SignerMiddleware::new(provider, wallet));
        let mailbox = Mailbox::new(H160::from_str(&self.mailbox)?, client);

        // Prepare message
        let mut msg = HyperlaneMessage::default();
        msg.recipient = H256::from(H160::from_str(&self.destination_address)?);
        msg.body = self.msg.as_bytes().into();
        msg.destination = self.destination_domain;

        // Get quote
        let quote = mailbox
            .quote_dispatch(
                msg.destination,
                msg.recipient.into(),
                msg.body.clone().into(),
            )
            .await?;
        println!("Quote: {:?}", quote);

        // Dispatch message
        let tx = mailbox
            .dispatch_0(
                msg.destination,
                msg.recipient.into(),
                msg.body.clone().into(),
            )
            .value(quote);
        println!("Dispatching message...");
        let pending_tx = tx.send().await?;
        println!("Transaction hash: {:?}", pending_tx.tx_hash());
        let receipt = pending_tx.await?.unwrap();
        println!("Transaction mined in block: {:?}", receipt.block_number);

        Ok(())
    }
}
