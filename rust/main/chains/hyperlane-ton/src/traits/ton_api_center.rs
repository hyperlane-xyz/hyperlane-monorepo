use crate::run_get_method::StackItem;
use crate::types::block_response::BlockResponse;
use crate::types::message::SendMessageResponse;
use crate::types::{
    account_state::AccountStateResponse, message::MessageResponse,
    run_get_method::RunGetMethodResponse, transaction::TransactionResponse,
    wallet_state::WalletStatesResponse,
};
use async_trait::async_trait;

#[async_trait]
pub trait TonApiCenter {
    async fn get_messages(
        &self,
        msg_hash: Option<Vec<String>>,
        body_hash: Option<String>,
        source: Option<String>,
        destination: Option<String>,
        opcode: Option<String>,
        start_utime: Option<i64>,
        end_utime: Option<i64>,
        start_lt: Option<i64>,
        end_lt: Option<i64>,
        direction: Option<String>,
        limit: Option<u32>,
        offset: Option<u32>,
        sort: Option<String>,
    ) -> Result<MessageResponse, Box<dyn std::error::Error>>;

    async fn get_transactions(
        &self,
        workchain: Option<i32>,
        shard: Option<String>,
        seqno: Option<i32>,
        mc_seqno: Option<i32>,
        account: Option<Vec<String>>,
        exclude_account: Option<Vec<String>>,
        hash: Option<String>,
        lt: Option<i64>,
        start_utime: Option<i64>,
        end_utime: Option<i64>,
        start_lt: Option<i64>,
        end_lt: Option<i64>,
        limit: Option<u32>,
        offset: Option<u32>,
        sort: Option<String>,
    ) -> Result<TransactionResponse, Box<dyn std::error::Error>>;

    async fn get_account_state(
        &self,
        address: String,
        include_boc: bool,
    ) -> Result<AccountStateResponse, Box<dyn std::error::Error>>;

    async fn run_get_method(
        &self,
        address: String,
        method: String,
        stack: Option<Vec<StackItem>>,
    ) -> Result<RunGetMethodResponse, Box<dyn std::error::Error + Send + Sync>>;

    async fn send_message(
        &self,
        boc: String, // base64-encoded boc
    ) -> Result<SendMessageResponse, Box<dyn std::error::Error>>;

    async fn get_wallet_states(
        &self,
        account: String,
    ) -> Result<WalletStatesResponse, Box<dyn std::error::Error>>;

    async fn get_transaction_by_message(
        &self,
        msg_hash: String,
        body_hash: Option<String>,
        opcode: Option<String>,
    ) -> Result<TransactionResponse, Box<dyn std::error::Error>>;

    async fn get_blocks(
        &self,
        workchain: i32,
        shard: Option<String>,
        seqno: Option<u64>,
        mc_seqno: Option<u32>,
        start_utime: Option<i64>,
        end_utime: Option<i64>,
        start_lt: Option<i64>,
        end_lt: Option<i64>,
        limit: Option<u32>,
        offset: Option<u32>,
        sort: Option<String>,
    ) -> Result<BlockResponse, Box<dyn std::error::Error>>;
}
