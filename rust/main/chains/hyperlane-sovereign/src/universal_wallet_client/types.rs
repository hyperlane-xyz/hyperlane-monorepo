use serde::Deserialize;

/// Collection of transaction statuses.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    Unknown,
    Dropped,
    Submitted,
    Published,
    Processed,
    Finalized,
}

/// Transaction information.
#[derive(Deserialize, Debug)]
pub struct TxInfo {
    #[allow(dead_code)]
    pub id: String,
    pub status: TxStatus,
}
