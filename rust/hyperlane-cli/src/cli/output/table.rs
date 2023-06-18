use crate::cli::output::OutputWriter;
use cli_table::{format::Justify, print_stdout, Table, WithTitle};
use ethers::abi::AbiEncode;
use hyperlane_core::HyperlaneMessage;
use textwrap::wrap;

pub struct TableOutput {
    pub messages: Vec<HyperlaneMessage>,
}

#[derive(Table)]
pub struct HyperlaneMessageOutput {
    #[table(title = "Version", justify = "Justify::Right")]
    pub version: u8,
    #[table(title = "Nonce")]
    pub nonce: u32,
    #[table(title = "Origin")]
    pub origin: u32,
    #[table(title = "Sender")]
    pub sender: String,
    #[table(title = "Destination")]
    pub destination: u32,
    #[table(title = "Recipient")]
    pub recipient: String,
    #[table(title = "Message Body")]
    pub body: String,
}

impl OutputWriter for TableOutput {
    fn print(&self) {
        let hyperlane_messages: Vec<HyperlaneMessageOutput> = self
            .messages
            .iter()
            .map(|msg| HyperlaneMessageOutput {
                version: msg.version,
                nonce: msg.nonce,
                origin: msg.origin,
                sender: self.format_address(msg.sender),
                destination: msg.destination,
                recipient: self.format_address(msg.recipient),
                body: wrap(msg.body.clone().encode_hex().as_str(), 30).join("\n"),
            })
            .collect();

        if hyperlane_messages.len() > 0 {
            let _ = print_stdout(hyperlane_messages.with_title());
        }
    }
}
