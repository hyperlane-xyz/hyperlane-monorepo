use snarkvm::{
    console::network::{const_assert, hrp2, AleoID},
    prelude::{MainnetV0, TestnetV0},
};
use snarkvm_console_account::Field;

/// Default Network that we go to
/// We need this as aleo annotates every type - even types that don't change with a different network
pub(crate) type CurrentNetwork = MainnetV0;
/// TxID Type
pub(crate) type TxID = AleoID<Field<TestnetV0>, { hrp2!("at") }>;
