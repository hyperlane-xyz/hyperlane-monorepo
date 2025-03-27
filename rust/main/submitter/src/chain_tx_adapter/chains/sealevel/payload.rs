use solana_sdk::instruction::Instruction as SealevelInstruction;

use crate::payload::{FullPayload, VmSpecificPayloadData};

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct SealevelPayload {
    pub instruction: SealevelInstruction,
}

pub(crate) trait Instruction {
    fn instruction(&self) -> &SealevelInstruction;
}

impl Instruction for FullPayload {
    fn instruction(&self) -> &SealevelInstruction {
        match self.data() {
            VmSpecificPayloadData::Svm(payload) => &payload.instruction,
            _ => panic!(),
        }
    }
}
