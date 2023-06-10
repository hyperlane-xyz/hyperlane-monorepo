use clap::Args;
use hyperlane_core::H256;

#[derive(Args, Debug, PartialEq)]
pub struct PayArgs {
    /// Destination chain identifier (unsigned integer)
    #[arg()]
    pub dest: u32,

    /// Id of message to pay for
    #[arg()]
    pub message_id: H256,

    /// Gas to pay on destination chain (will be converted according gas price and exchange rate)
    #[arg(default_value = "10000")]
    pub gas: u32,
}
