use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransactionResponse {
    pub transactions: Vec<Transaction>,
    pub address_book: AddressBook,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Transaction {
    pub account: String,
    pub hash: String,
    pub lt: String,
    pub now: u64,
    pub orig_status: String,
    pub end_status: String,
    pub total_fees: String,
    pub prev_trans_hash: String,
    pub prev_trans_lt: String,
    pub description: Description,
    pub block_ref: BlockRef,
    pub in_msg: Option<Message>,
    pub out_msgs: Vec<Message>,
    pub account_state_before: AccountState,
    pub account_state_after: AccountState,
    pub mc_block_seqno: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Description {
    #[serde(rename = "type")]
    pub r#type: String,
    pub action: Action,
    pub aborted: bool,
    pub credit_ph: Option<Credit>,
    pub destroyed: bool,
    pub compute_ph: ComputePhase,
    pub storage_ph: StoragePhase,
    pub credit_first: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Action {
    pub valid: bool,
    pub success: bool,
    pub no_funds: bool,
    pub result_code: i32,
    pub tot_actions: u32,
    pub msgs_created: u32,
    pub spec_actions: u32,
    pub tot_msg_size: MessageSize,
    pub status_change: String,
    pub total_fwd_fees: String,
    pub skipped_actions: u32,
    pub action_list_hash: String,
    pub total_action_fees: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MessageSize {
    pub bits: String,
    pub cells: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Credit {
    pub credit: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ComputePhase {
    pub mode: i32,
    #[serde(rename = "type")]
    pub r#type: Option<String>,
    pub success: bool,
    pub gas_fees: String,
    pub gas_used: String,
    pub vm_steps: u32,
    pub exit_code: i32,
    pub gas_limit: String,
    pub gas_credit: String,
    pub msg_state_used: bool,
    pub account_activated: bool,
    pub vm_init_state_hash: String,
    pub vm_final_state_hash: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoragePhase {
    pub status_change: String,
    pub storage_fees_collected: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BlockRef {
    pub workchain: i32,
    pub shard: String,
    pub seqno: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub hash: String,
    pub source: Option<String>,
    pub destination: String,
    pub value: Option<String>,
    pub fwd_fee: Option<String>,
    pub ihr_fee: Option<String>,
    pub created_lt: Option<String>,
    pub created_at: Option<String>,
    pub opcode: Option<String>,
    pub ihr_disabled: Option<bool>,
    pub bounce: Option<bool>,
    pub bounced: Option<bool>,
    pub import_fee: Option<String>,
    pub message_content: MessageContent,
    pub init_state: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MessageContent {
    pub hash: String,
    pub body: String,
    pub decoded: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AccountState {
    pub hash: String,
    pub balance: Option<String>,
    pub account_status: Option<String>,
    pub frozen_hash: Option<String>,
    pub code_hash: Option<String>,
    pub data_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AddressBook {
    #[serde(flatten)]
    pub addresses: std::collections::HashMap<String, AddressInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AddressInfo {
    pub user_friendly: String,
}
