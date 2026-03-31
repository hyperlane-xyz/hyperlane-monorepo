use std::fmt::Debug;

use solana_sdk::instruction::Instruction as SealevelInstruction;
use solana_sdk::pubkey::Pubkey;

use hyperlane_sealevel::SealevelTxCostEstimate;

use crate::transaction::VmSpecificTxData;
use crate::{
    adapter::chains::sealevel::{payload, payload::InstructionPayload},
    payload::FullPayload,
};

#[derive(Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct SealevelTxPrecursor {
    pub instruction: SealevelInstruction,
    pub alt_address: Option<Pubkey>,
    pub estimate: SealevelTxCostEstimate,
}

impl Debug for SealevelTxPrecursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealevelTxPrecursor")
            .field("alt_address", &self.alt_address)
            .field("cost_estimate", &self.estimate)
            .finish()
    }
}

impl From<SealevelTxPrecursor> for VmSpecificTxData {
    fn from(value: SealevelTxPrecursor) -> Self {
        VmSpecificTxData::Svm(Box::new(value))
    }
}

impl SealevelTxPrecursor {
    pub fn new(
        instruction: SealevelInstruction,
        alt_address: Option<Pubkey>,
        estimate: SealevelTxCostEstimate,
    ) -> Self {
        Self {
            instruction,
            alt_address,
            estimate,
        }
    }

    pub fn from_payload(payload: &FullPayload) -> Self {
        let (instruction, alt_address) = payload.instruction_and_alt();
        SealevelTxPrecursor::new(instruction, alt_address, SealevelTxCostEstimate::default())
    }
}
