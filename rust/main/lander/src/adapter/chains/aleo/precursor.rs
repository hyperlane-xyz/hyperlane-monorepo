use std::fmt::Debug;

use serde::{Deserialize, Serialize};

use hyperlane_aleo::{AleoTxCalldata, FeeEstimate};
use hyperlane_core::H512;

use crate::transaction::{Transaction, VmSpecificTxData};
use crate::LanderError;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub struct AleoTxPrecursor {
    /// Program ID to call
    pub program_id: String,
    /// Function name to call on the program
    pub function_name: String,
    /// Input parameters for the function call
    pub inputs: Vec<String>,
    /// Estimated fee information
    pub estimated_fee: Option<FeeEstimate>,
}

impl Debug for AleoTxPrecursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        #[allow(dead_code)]
        #[derive(Debug)]
        struct AleoTxPrecursorDebug<'a> {
            program_id: &'a str,
            function_name: &'a str,
            inputs_len: usize,
            estimated_fee: &'a Option<FeeEstimate>,
        }

        let Self {
            program_id,
            function_name,
            inputs,
            estimated_fee,
        } = self;
        std::fmt::Debug::fmt(
            &AleoTxPrecursorDebug {
                program_id,
                function_name,
                inputs_len: inputs.len(),
                estimated_fee,
            },
            f,
        )
    }
}

impl AleoTxPrecursor {
    pub fn new(program_id: String, function_name: String, inputs: Vec<String>) -> Self {
        Self {
            program_id,
            function_name,
            inputs,
            estimated_fee: None,
        }
    }
}

impl Eq for AleoTxPrecursor {}

impl From<AleoTxCalldata> for AleoTxPrecursor {
    fn from(value: AleoTxCalldata) -> Self {
        Self {
            program_id: value.program_id,
            function_name: value.function_name,
            inputs: value.inputs,
            estimated_fee: None,
        }
    }
}

#[cfg(test)]
mod tests;
