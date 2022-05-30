use crate::err::GelatoError;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const RELAY_URL: &str = "https://relay.gelato.digital";

pub struct TaskStatusCall {
    pub http: Arc<reqwest::Client>,
    pub args: TaskStatusCallArgs,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusCallArgs {
    pub task_id: String,
}

#[derive(Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusCallResult {
    pub data: Vec<TransactionStatus>,
}

impl TaskStatusCall {
    pub async fn run(&self) -> Result<TaskStatusCallResult, GelatoError> {
        let url = format!("{}/tasks/GelatoMetaBox/{}", RELAY_URL, self.args.task_id);
        let res = self.http.get(url).send().await?;
        let result_json = res.json().await.unwrap();
        let result = TaskStatusCallResult::from(result_json);
        Ok(TaskStatusCallResult::from(result))
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
pub enum TaskStatus {
    CheckPending,
    ExecPending,
    ExecSuccess,
    ExecReverted,
    WaitingForConfirmation,
    Blacklisted,
    Cancelled,
    NotFound,
}

#[derive(Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionStatus {
    pub service: String,
    pub chain: String,
    pub task_id: String,
    pub task_state: TaskStatus,
    pub created_at: Option<String>,
    //pub last_check: Option<Check>,
    pub execution: Option<Execution>,
    pub last_execution: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub status: String,
    pub transaction_hash: String,
    pub block_number: u64,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Check {
    Timestamp(String),
    CheckWithMetadata(CheckInfo),
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInfo {
    pub task_state: TaskStatus,
    pub message: String,
    pub payload: Payload,
    pub chain: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub to: String,
    pub data: String,
    pub type_: String,
    pub fee_data: FeeData,
    pub fee_token: String,
    pub gas_limit: BigNumType,
    pub is_flashbots: Option<bool>,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeData {
    pub gas_price: BigNumType,
    pub max_fee_per_gas: BigNumType,
    pub max_priority_fee_per_gas: BigNumType,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BigNumType {
    pub hex: String,
    pub type_: String,
}
