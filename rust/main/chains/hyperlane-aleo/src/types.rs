use serde::{Deserialize, Serialize};
use snarkvm::{
    console::network::{const_assert, hrp2, AleoID},
    prelude::{MainnetV0, TestnetV0},
};
use snarkvm_console_account::Field;

// This actually works for all networks. I've raised this with the Aleo team, but the type annotation here doesn't actually change the underlying type.
// The Aleo VM types all inherit a generic Network type, but that Type is not relevant for many structs of Aleo and is supposed to be more of an additional information for the internal VM processing.
// They need this, because they generate ZK Proofs differently for different networks but the actual data of these types are the same across all Networks.
// We pass CurrentNetwork into a lot of types, because we don't have to generate ZK Proofs in almost every situation - except when submitting a TX. There is one exception to this and that is when parsing/handling with Blocks.
// The Block type verifies its validity on creation and that changes based on the Network type, that's why we have to pass the correct Type when dealing with blocks.
pub(crate) type CurrentNetwork = MainnetV0;
/// TxID Type
pub(crate) type TxID = AleoID<Field<TestnetV0>, { hrp2!("at") }>;

/// Proving Request
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProvingRequest {
    /// The function that needs to be executed
    pub authorization: serde_json::Value, // Some type of Authorization::<Network>
    /// Fee for the TX
    pub fee_authorization: Option<serde_json::Value>,
    /// Whether or not the service will broadcast the transaction
    pub broadcast: bool,
}

/// Proving Response
#[derive(Serialize, Deserialize, Debug)]
pub struct ProvingResponse {
    /// Transaction with Proof
    pub transaction: serde_json::Value, // Transaction::<Network>
    /// Whether or not it was broadcasted
    #[serde(default)]
    pub broadcast: Option<bool>,
}

#[derive(Debug)]
pub struct FeeEstimate {
    /// Base fee
    pub base_fee: u64,
    /// Priority fee
    pub priority_fee: u64,
    /// Total fee
    pub total_fee: u64,
}
