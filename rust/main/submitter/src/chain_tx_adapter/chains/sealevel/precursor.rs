use solana_sdk::instruction::Instruction as SealevelInstruction;

use hyperlane_sealevel::SealevelTxCostEstimate;

use crate::chain_tx_adapter::chains::sealevel::payload;
use crate::chain_tx_adapter::chains::sealevel::payload::Instruction;
use crate::payload::FullPayload;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub(crate) struct SealevelTxPrecursor {
    pub(crate) instruction: SealevelInstruction,
    pub(crate) estimate: SealevelTxCostEstimate,
}

impl SealevelTxPrecursor {
    pub(crate) fn new(instruction: SealevelInstruction, estimate: SealevelTxCostEstimate) -> Self {
        Self {
            instruction,
            estimate,
        }
    }

    pub(crate) fn from_payload(payload: &FullPayload) -> Self {
        let instruction = payload.instruction();
        SealevelTxPrecursor::new(instruction.clone(), SealevelTxCostEstimate::default())
    }
}
