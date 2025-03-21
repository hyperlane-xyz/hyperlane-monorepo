use solana_sdk::instruction::Instruction;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub(crate) struct SealevelPayload {
    pub(crate) instruction: Instruction,
}
