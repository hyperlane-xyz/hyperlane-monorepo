use std::fmt::Debug;

use solana_sdk::instruction::Instruction as SealevelInstruction;

use hyperlane_sealevel::{SealevelTransactionFormat, SealevelTxCostEstimate};

use crate::transaction::VmSpecificTxData;
use crate::{
    adapter::chains::sealevel::{payload, payload::InstructionPayload},
    payload::FullPayload,
};

#[derive(Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct SealevelTxPrecursor {
    pub instruction: SealevelInstruction,
    /// Transaction representation and any non-empty ALT addresses.
    ///
    /// Accepts the legacy singular `alt_address` key (scalar or null) so precursors
    /// persisted by an older lander keep deserializing after upgrade.
    #[serde(default, alias = "alt_address")]
    pub alt_addresses: SealevelTransactionFormat,
    pub estimate: SealevelTxCostEstimate,
}

impl Debug for SealevelTxPrecursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealevelTxPrecursor")
            .field("alt_addresses", &self.alt_addresses)
            .field("cost_estimate", &self.estimate)
            .finish()
    }
}

impl From<SealevelTxPrecursor> for VmSpecificTxData {
    fn from(value: SealevelTxPrecursor) -> Self {
        VmSpecificTxData::Svm(Box::new(value))
    }
}

impl SealevelTxPrecursor {
    pub fn new(
        instruction: SealevelInstruction,
        alt_addresses: SealevelTransactionFormat,
        estimate: SealevelTxCostEstimate,
    ) -> Self {
        Self {
            instruction,
            alt_addresses,
            estimate,
        }
    }

    pub fn from_payload(payload: &FullPayload) -> Self {
        let (instruction, alt_addresses) = payload.instruction_and_alt();
        SealevelTxPrecursor::new(
            instruction,
            alt_addresses,
            SealevelTxCostEstimate::default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::pubkey::Pubkey;

    #[derive(serde::Serialize)]
    struct LegacyPrecursor {
        instruction: SealevelInstruction,
        alt_address: Option<Pubkey>,
        estimate: SealevelTxCostEstimate,
    }

    #[test]
    fn deserializes_persisted_singular_alt() {
        let alt = Pubkey::new_unique();
        let legacy = LegacyPrecursor {
            instruction: SealevelInstruction {
                program_id: Pubkey::new_unique(),
                accounts: vec![],
                data: vec![],
            },
            alt_address: Some(alt),
            estimate: SealevelTxCostEstimate::default(),
        };

        let encoded = serde_json::to_vec(&legacy).unwrap();
        let decoded: SealevelTxPrecursor = serde_json::from_slice(&encoded).unwrap();

        assert_eq!(
            decoded.alt_addresses,
            SealevelTransactionFormat::V0 {
                alt_addresses: alt.into()
            }
        );
    }
}
