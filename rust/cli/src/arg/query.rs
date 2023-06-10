use clap::Args;

#[derive(Args, Debug, PartialEq)]
pub struct QueryArgs {
    /// Match criteria for messages to search for in either JSON or CSV format.
    ///
    /// CSV format (each item is a CSV list):
    ///     originDomain:senderAddress:destinationDomain:recipientAddress
    ///
    /// CSV example: 1,2:0x1234,0x5678:5:0x7890
    ///
    /// JSON equivalent (outer list is optional if only one item):
    /// [{"originDomain": [1, 2], "senderAddress": ["0x1234", "0x5678"],
    ///   "destinationDomain": 5, "recipientAddress": "0x7890"}]
    ///
    /// Note that the formats need to be correct and above hash values are invalid.
    #[arg(short, long)]
    pub criteria: Vec<String>,

    // /// Match criteria file in JSON format.
    // #[arg(short, long)]
    // pub file: Option<PathBuf>,

    // /// Maximum number of messages to return.
    // /// If negative, will return last N matching messages.
    // #[arg(short, long, default_value = "-10")]
    // pub max: i32,
    /// Start block number to search from.
    /// If not specified, will search last 100 blocks.
    /// If negative (-n), will search from latest block + 1 - n.
    #[arg(short, long, default_value = "-1000")]
    pub start: i32,

    /// End block number to search to.
    /// If not specified, will search until latest block.
    /// If negative (-n), will search to latest block + 1 - n.
    #[arg(short, long, default_value = "-1")]
    pub end: i32,

    /// Do not run; print extracted parameters and exit.
    #[arg(short, long, default_value = "false", default_missing_value = "true")]
    pub debug: bool,
}
