use async_trait::async_trait;

use hyperlane_core::ChainResult;

use crate::{
    run_get_method::StackItem,
    types::{
        account_state::AccountStateResponse,
        block_response::BlockResponse,
        message::{MessageResponse, SendMessageResponse},
        run_get_method::RunGetMethodResponse,
        transaction::TransactionResponse,
        wallet_state::{WalletInformation, WalletStatesResponse},
    },
};

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
    ) -> ChainResult<MessageResponse>;

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
    ) -> ChainResult<TransactionResponse>;

    async fn get_account_state(
        &self,
        address: String,
        include_boc: bool,
    ) -> ChainResult<AccountStateResponse>;
    async fn get_wallet_information(
        &self,
        address: &str,
        use_v2: bool,
    ) -> ChainResult<WalletInformation>;

    async fn run_get_method(
        &self,
        address: String,
        method: String,
        stack: Option<Vec<StackItem>>,
    ) -> ChainResult<RunGetMethodResponse>;

    async fn send_message(
        &self,
        boc: String, // base64-encoded boc
    ) -> ChainResult<SendMessageResponse>;

    async fn get_wallet_states(&self, account: String) -> ChainResult<WalletStatesResponse>;

    async fn get_transaction_by_message(
        &self,
        msg_hash: String,
        body_hash: Option<String>,
        opcode: Option<String>,
    ) -> ChainResult<TransactionResponse>;

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
    ) -> ChainResult<BlockResponse>;
}
