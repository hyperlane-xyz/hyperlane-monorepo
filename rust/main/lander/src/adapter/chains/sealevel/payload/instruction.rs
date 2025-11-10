use solana_sdk::instruction::Instruction as SealevelInstruction;

use crate::payload::FullPayload;

pub(crate) trait Instruction {
    fn instruction(&self) -> SealevelInstruction;
}

impl Instruction for FullPayload {
    fn instruction(&self) -> SealevelInstruction {
        serde_json::from_slice::<SealevelInstruction>(&self.data)
            .expect("Payload should contain serialised Instruction for Sealevel")
    }
}
