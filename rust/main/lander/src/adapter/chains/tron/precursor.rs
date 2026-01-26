use std::fmt::Debug;

use derive_new::new;
use ethers::{
    abi::Function,
    types::{transaction::eip2718::TypedTransaction, H160},
};
use ethers_core::types::transaction::eip2718::TypedTransaction::{Eip1559, Eip2930, Legacy};

use crate::payload::{FullPayload, PayloadDetails};
use crate::transaction::{Transaction, VmSpecificTxData};

#[derive(new, Clone, serde::Deserialize, serde::Serialize, Debug, PartialEq)]
pub struct TronTxPrecursor {
    pub tx: TypedTransaction,
    pub function: Function,
}

impl Eq for TronTxPrecursor {}

impl From<TronTxPrecursor> for VmSpecificTxData {
    fn from(value: TronTxPrecursor) -> Self {
        VmSpecificTxData::Tron(Box::new(value))
    }
}

impl TronTxPrecursor {
    pub fn from_data(data: &[u8]) -> Self {
        let (tx, function) = serde_json::from_slice::<(TypedTransaction, Function)>(data).expect("PayloadDetails should contain (TypedTransaction, Function) for Tron as success_criteria");
        TronTxPrecursor::new(tx, function)
    }
}

pub trait Precursor {
    fn precursor(&self) -> &TronTxPrecursor;
    fn precursor_mut(&mut self) -> &mut TronTxPrecursor;
}

#[allow(clippy::panic)]
impl Precursor for Transaction {
    fn precursor(&self) -> &TronTxPrecursor {
        match &self.vm_specific_data {
            VmSpecificTxData::Tron(precursor) => precursor,
            _ => panic!(),
        }
    }

    fn precursor_mut(&mut self) -> &mut TronTxPrecursor {
        match &mut self.vm_specific_data {
            VmSpecificTxData::Tron(precursor) => precursor,
            _ => panic!(),
        }
    }
}
