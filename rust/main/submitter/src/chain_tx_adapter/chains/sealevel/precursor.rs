use solana_sdk::instruction::Instruction;

use hyperlane_sealevel::SealevelTxCostEstimate;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub(crate) struct SealevelTxPrecursor {
    pub(crate) instruction: Instruction,
    pub(crate) estimate: SealevelTxCostEstimate,
}

impl SealevelTxPrecursor {
    pub(crate) fn new(instruction: Instruction, estimate: SealevelTxCostEstimate) -> Self {
        Self {
            instruction,
            estimate,
        }
    }
}
