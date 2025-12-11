use serde::{Deserialize, Serialize};

use hyperlane_aleo::AleoTxData;
use hyperlane_core::H512;

use crate::transaction::{Transaction, VmSpecificTxData};
use crate::LanderError;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AleoTxPrecursor {
    /// Program ID to call
    pub program_id: String,
    /// Function name to call on the program
    pub function_name: String,
    /// Input parameters for the function call
    pub inputs: Vec<String>,
}

impl std::fmt::Debug for AleoTxPrecursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        #[allow(dead_code)]
        #[derive(Debug)]
        struct AleoTxPrecursorDebug<'a> {
            program_id: &'a str,
            function_name: &'a str,
            inputs_len: usize,
        }

        let Self {
            program_id,
            function_name,
            inputs,
        } = self;
        std::fmt::Debug::fmt(
            &AleoTxPrecursorDebug {
                program_id,
                function_name,
                inputs_len: inputs.len(),
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
        }
    }
}

impl From<AleoTxData> for AleoTxPrecursor {
    fn from(value: AleoTxData) -> Self {
        Self {
            program_id: value.program_id,
            function_name: value.function_name,
            inputs: value.inputs,
        }
    }
}

impl From<AleoTxPrecursor> for VmSpecificTxData {
    fn from(value: AleoTxPrecursor) -> Self {
        VmSpecificTxData::Aleo(Box::new(value))
    }
}

#[cfg(test)]
mod tests;
