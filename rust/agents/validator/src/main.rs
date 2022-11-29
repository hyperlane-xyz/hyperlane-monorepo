//! The validator signs Outbox checkpoints that have reached finality.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use eyre::Result;

use hyperlane_base::agent_main;

use crate::validator::Validator;

mod settings;
mod submit;
mod validator;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    agent_main::<Validator>().await
}
