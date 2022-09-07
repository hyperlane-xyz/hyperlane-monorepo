use crate::err::GelatoError;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::instrument;

const RELAY_URL: &str = "https://relay.gelato.digital";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusCallArgs {
    pub task_id: String,
}

#[derive(Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusCallResult {
    pub data: Vec<TransactionStatus>,
}

#[derive(Debug)]
pub struct TaskStatusCall {
    pub http: Arc<reqwest::Client>,
    pub args: TaskStatusCallArgs,
}
impl TaskStatusCall {
    #[instrument]
    pub async fn run(&self) -> Result<TaskStatusCallResult, GelatoError> {
        let url = format!("{}/tasks/GelatoMetaBox/{}", RELAY_URL, self.args.task_id);
        let res = self.http.get(url).send().await?;
        let result: TaskStatusCallResult = res.json().await?;
        Ok(result)
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
    // TODO(webbhorn): Consider not even trying to parse as many of these optionals as we can
    // get away with. It is kind of fragile and awkward since Gelato does not make any
    // guarantees about which fields will be present in different scenarios.
    pub created_at: Option<String>,
    pub last_check: Option<Check>,
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

// Sometimes the value corresponding to the 'last_check' key is a string timestamp, other times it
// is filled in with lots of detailed fields. Represent that with an enum and let serde figure it
// out.
#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(untagged)]
pub enum Check {
    Timestamp(String),
    CheckWithMetadata(Box<CheckInfo>),
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
pub struct CheckInfo {
    // See `created_at` to understand why we rename this field
    // rather than using `#[serde(rename_all = "camelCase")].
    #[serde(rename = "taskState")]
    pub task_state: TaskStatus,
    pub message: String,
    pub payload: Option<Payload>,
    pub chain: Option<String>,
    // Sadly, this is not serialized in camelCase by Gelato's API, and is
    // named `created_at`.
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
