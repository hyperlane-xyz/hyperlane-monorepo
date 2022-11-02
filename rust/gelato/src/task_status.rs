use serde::{Deserialize, Serialize};
use tracing::instrument;

use crate::{parse_response, RELAY_URL};

#[derive(Debug, Clone, Copy, Eq, PartialEq, Deserialize, Serialize)]
pub enum TaskState {
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
pub struct TaskStatus {
    pub chain_id: u64,
    pub task_id: String,
    pub task_state: TaskState,
    pub creation_date: String,
    /// Populated after the relay first simulates the task (taskState= CheckPending)
    pub last_check_date: Option<String>,
    /// Populated in case of simulation error or task cancellation (taskState= CheckPending | Cancelled)
    pub last_check_message: Option<String>,
    /// Populated as soon as the task is published to the mempool (taskState = WaitingForConfirmation)
    pub transaction_hash: Option<String>,
    /// Populated when the transaction is mined
    pub execution_date: Option<String>,
    /// Populated when the transaction is mined
    pub block_number: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusApiCallArgs {
    pub task_id: String,
}

#[derive(Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusApiCallResult {
    /// Typically present when a task cannot be found (also gives 404 HTTP status)
    pub message: Option<String>,
    /// Present when a task is found
    pub task: Option<TaskStatus>,
}

impl TaskStatusApiCallResult {
    pub fn task_state(&self) -> TaskState {
        if let Some(task) = &self.task {
            return task.task_state;
        }
        TaskState::NotFound
    }
}

#[derive(Debug)]
pub struct TaskStatusApiCall {
    pub http: reqwest::Client,
    pub args: TaskStatusApiCallArgs,
}

impl TaskStatusApiCall {
    #[instrument]
    pub async fn run(&self) -> eyre::Result<TaskStatusApiCallResult> {
        let url = format!("{}/tasks/status/{}", RELAY_URL, self.args.task_id);
        let res = self.http.get(url).send().await?;
        let result: TaskStatusApiCallResult = parse_response(res).await?;
        Ok(result)
    }
}
