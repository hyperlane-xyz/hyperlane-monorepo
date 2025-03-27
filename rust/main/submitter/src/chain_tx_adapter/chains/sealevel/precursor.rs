use solana_sdk::instruction::Instruction as SealevelInstruction;

use hyperlane_sealevel::SealevelTxCostEstimate;

use crate::chain_tx_adapter::chains::sealevel::payload;
use crate::chain_tx_adapter::chains::sealevel::payload::Instruction;
use crate::payload::FullPayload;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct SealevelTxPrecursor {
    pub instruction: SealevelInstruction,
    pub estimate: SealevelTxCostEstimate,
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
