use std::fmt::Debug;

use solana_sdk::instruction::Instruction as SealevelInstruction;

use hyperlane_sealevel::SealevelTxCostEstimate;

use crate::{
    adapter::chains::sealevel::{payload, payload::Instruction},
    payload::FullPayload,
};

#[derive(Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct SealevelTxPrecursor {
    pub instruction: SealevelInstruction,
    pub estimate: SealevelTxCostEstimate,
}

impl Debug for SealevelTxPrecursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealevelTxPrecursor")
            .field("cost_estimate", &self.estimate)
            .finish()
    }
}

impl SealevelTxPrecursor {
    pub fn new(instruction: SealevelInstruction, estimate: SealevelTxCostEstimate) -> Self {
        Self {
            instruction,
            estimate,
        }
    }

    pub fn from_payload(payload: &FullPayload) -> Self {
        let instruction = payload.instruction();
        SealevelTxPrecursor::new(instruction.clone(), SealevelTxCostEstimate::default())
    }
}
