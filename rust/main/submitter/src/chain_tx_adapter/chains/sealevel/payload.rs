use solana_sdk::instruction::Instruction;

use crate::payload::{FullPayload, VmSpecificPayloadData};

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub(crate) struct SealevelPayload {
    pub(crate) instruction: Instruction,
}

pub(crate) trait GetInstruction {
    fn instruction(&self) -> &Instruction;
}

impl GetInstruction for FullPayload {
    fn instruction(&self) -> &Instruction {
        match self.data() {
            VmSpecificPayloadData::Svm(payload) => &payload.instruction,
            _ => panic!(),
        }
    }
}
