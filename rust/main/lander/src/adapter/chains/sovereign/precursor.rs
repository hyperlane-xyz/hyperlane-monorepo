use hyperlane_core::H256;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::transaction::VmSpecificTxData;

/// Gas estimate from simulation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GasEstimate {
    pub gas_used: u128,
    pub priority_fee: u128,
}

/// Transaction precursor data for Sovereign chains.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SovereignTxPrecursor {
    /// The call message to be submitted (JSON representation)
    pub call_message: Value,
    /// Gas estimate from simulation
    pub gas_estimate: Option<GasEstimate>,
    /// The transaction hash once submitted
    pub tx_hash: Option<H256>,
    /// Serialized transaction body (base64 encoded)
    pub serialized_body: Option<String>,
}

impl SovereignTxPrecursor {
    pub fn new(call_message: Value) -> Self {
        Self {
            call_message,
            gas_estimate: None,
            tx_hash: None,
            serialized_body: None,
        }
    }
}

impl From<SovereignTxPrecursor> for VmSpecificTxData {
    fn from(precursor: SovereignTxPrecursor) -> Self {
        VmSpecificTxData::Sovereign(Box::new(precursor))
    }
}
