use crate::cli::args::parse::ParseEthPrimitives;
use crate::cli::cmd::{ExecuteCliCmd, SendCmd};
use crate::cli::output::OutputWriter;
use async_trait::async_trait;
use colored::Colorize;
use ethers::utils::hex;
use std::error::Error;

#[async_trait]
impl ExecuteCliCmd for SendCmd {
    async fn execute(&self) -> Result<(), Box<dyn Error>> {
        if self.chain_destination == self.client_conf.domain.id() as i32 {
            return Err(format!(
                "The Origin and Destination chains must be different got={}",
                self.chain_destination.to_string()
            )
            .into());
        }

        println!("{}", "Transaction Prepared".yellow().bold());

        self.print();

        println!();
        println!("Submitting transaction...");

        let address_destination = match self
            .address_destination
            .parse_address("Destination".to_string())
        {
            Ok(result) => result,
            Err(err) => return Err(err),
        };

        let mailbox = match self.client_conf.build_mailbox().await {
            Ok(result) => result,
            Err(err) => {
                return Err(format!("Failed to resolve mailbox got={}", err.to_string()).into())
            }
        };

        let message_body = match hex::decode(&self.bytes.clone()[2..]) {
            Ok(result) => result,
            Err(err) => {
                return Err(format!("Failed to decode hex bytes got={}", err.to_string()).into())
            }
        };

        let outcome = match mailbox
            .dispatch(
                self.chain_destination as u32,
                address_destination,
                message_body,
            )
            .await
        {
            Ok(result) => result,
            Err(err) => {
                return Err(format!("Failed to dispatch message got={}", err.to_string()).into())
            }
        };

        println!();
        println!("{}", "Transaction Sent".green().bold());
        outcome.print();

        Ok(())
    }
}
