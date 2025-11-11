use snarkvm::{
    console::network::{const_assert, hrp2, AleoID},
    prelude::{MainnetV0, TestnetV0},
};
use snarkvm_console_account::Field;

// This actually works for all networks. I've raised this with the Aleo team, but the type annotation here doesn't actually change the underlying type.
// The Aleo VM types all inherit a generic Network type, but that Type is not relevant for many structs of Aleo and is supposed to be more of an additional information for the internal VM processing.
// They need this, because they generate ZK Proofs differently for different networks but the actual data of these types are the same across all Networks.
// We pass CurrentNetwork into a lot of types, because we don't have to generate ZK Proofs in almost every situation - except when submitting a TX. There is one exception to this and that is when parsing/handling with Blocks.
// The Block type verifies its validity on creation and that changes based on the Network type, thats why we have to pass the correct Type when dealing with blocks.
pub(crate) type CurrentNetwork = MainnetV0;
/// TxID Type
pub(crate) type TxID = AleoID<Field<TestnetV0>, { hrp2!("at") }>;
