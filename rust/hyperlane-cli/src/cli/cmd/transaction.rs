use crate::cli::cmd::SendCmd;
use crate::cli::output::OutputWriter;
use cli_table::{print_stdout, Table, WithTitle};
use ethers::abi::AbiEncode;
use hyperlane_core::TxOutcome;

#[derive(Table)]
pub struct PreparedTransaction {
    #[table(title = "Destination Address")]
    pub destination: String,
    #[table(title = "Destination Chain")]
    pub chain_id: i32,
    #[table(title = "Mailbox Address")]
    pub mailbox_address: String,
    #[table(title = "Message Body")]
    pub body: String,
}

impl OutputWriter for SendCmd {
    fn print(&self) {
        let prepared_transaction = vec![PreparedTransaction {
            destination: self.address_destination.clone(),
            chain_id: self.chain_destination,
            mailbox_address: self.format_address(self.client_conf.addresses.mailbox),
            body: self.bytes.clone(),
        }];

        let _ = print_stdout(prepared_transaction.with_title());
    }
}

#[derive(Table)]
pub struct SentTransaction {
    #[table(title = "TX Hash")]
    pub tx_hash: String,
    #[table(title = "Gas Used")]
    pub gas_used: u64,
    #[table(title = "Gas Price")]
    pub gas_price: u64,
}

impl OutputWriter for TxOutcome {
    fn print(&self) {
        let sent_transaction = vec![SentTransaction {
            tx_hash: self.txid.encode_hex(),
            gas_used: self.gas_used.as_u64(),
            gas_price: self.gas_price.as_u64(),
        }];

        let _ = print_stdout(sent_transaction.with_title());
    }
}
