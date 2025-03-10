use derive_new::new;
use hyperlane_core::{ChainCommunicationError, ChainResult};
use serde::{Deserialize, Serialize};
use tonlib_core::cell::ArcCell;

use crate::{error::HyperlaneTonError, ConversionUtils};

#[derive(Deserialize, Debug, Default)]
pub struct RunGetMethodResponse {
    pub gas_used: u64,
    pub exit_code: i32,
    pub stack: Vec<StackItem>,
}

#[derive(Debug, Serialize, Deserialize, new)]
pub struct StackItem {
    #[serde(rename = "type")]
    pub r#type: String,
    pub value: StackValue,
}

impl StackItem {
    pub fn as_cell(&self) -> ChainResult<ArcCell> {
        if self.r#type != "cell" {
            return Err(ChainCommunicationError::from(
                HyperlaneTonError::ParsingError(format!(
                    "Unexpected stack item type: {:?}",
                    self.r#type
                )),
            ));
        }

        let boc = ConversionUtils::extract_boc_from_stack_item(&self)?;
        ConversionUtils::parse_root_cell_from_boc(&boc).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse root cell: {:?}",
                e
            )))
        })
    }
}

#[derive(Debug, Serialize, Deserialize, new)]
#[serde(untagged)]
pub enum StackValue {
    String(String),
    List(Vec<StackValue>),
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub code: i32,
    pub error: String,
}

#[derive(Debug)]
pub enum GetMethodResponse {
    Success(RunGetMethodResponse),
    Error(ErrorResponse),
}

impl GetMethodResponse {
    pub fn from_json(json: &str) -> Result<GetMethodResponse, serde_json::Error> {
        match serde_json::from_str::<RunGetMethodResponse>(json) {
            Ok(success) => Ok(GetMethodResponse::Success(success)),
            Err(_) => {
                let err = serde_json::from_str::<ErrorResponse>(json)?;
                Ok(GetMethodResponse::Error(err))
            }
        }
    }
}
