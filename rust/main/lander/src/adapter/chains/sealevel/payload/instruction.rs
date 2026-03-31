use hyperlane_sealevel::SealevelProcessPayload;
use solana_sdk::instruction::Instruction as SealevelInstruction;
use solana_sdk::pubkey::Pubkey;

use crate::payload::FullPayload;

pub(crate) trait InstructionPayload {
    fn instruction_and_alt(&self) -> (SealevelInstruction, Option<Pubkey>);
}

impl InstructionPayload for FullPayload {
    fn instruction_and_alt(&self) -> (SealevelInstruction, Option<Pubkey>) {
        let payload: SealevelProcessPayload = serde_json::from_slice(&self.data)
            .expect("Payload should contain SealevelProcessPayload");
        (payload.instruction, payload.alt_address)
    }
}
