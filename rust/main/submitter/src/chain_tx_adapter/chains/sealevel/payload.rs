use solana_sdk::instruction::Instruction;

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub(crate) struct SealevelPayload {
    pub(crate) instruction: Instruction,
}
