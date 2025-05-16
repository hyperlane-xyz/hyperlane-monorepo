//! The validator signs Mailbox checkpoints that have reached finality.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use eyre::Result;

use hyperlane_base::agent_main;

use crate::validator::Validator;

mod server;
mod settings;
mod submit;
mod validator;

#[cfg(test)]
mod test_utils;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    // Logging is not initialised at this point, so, using `println!`
    println!("Validator starting up...");

    agent_main::<Validator>().await
}
