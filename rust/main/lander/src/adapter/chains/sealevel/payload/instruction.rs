use hyperlane_sealevel::SealevelProcessPayload;
use hyperlane_sealevel::SealevelTransactionFormat;
use solana_sdk::instruction::Instruction as SealevelInstruction;

use crate::payload::FullPayload;

pub(crate) trait InstructionPayload {
    fn instruction_and_alt(&self) -> (SealevelInstruction, SealevelTransactionFormat);
}

impl InstructionPayload for FullPayload {
    fn instruction_and_alt(&self) -> (SealevelInstruction, SealevelTransactionFormat) {
        let payload: SealevelProcessPayload = serde_json::from_slice(&self.data)
            .expect("Payload should contain SealevelProcessPayload");
        (payload.instruction, payload.alt_addresses)
    }
}
