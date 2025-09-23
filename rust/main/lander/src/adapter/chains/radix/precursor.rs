use std::fmt::Debug;

use ethers::{
    abi::Function,
    types::{transaction::eip2718::TypedTransaction, H160},
};
use hyperlane_core::H512;
use radix_transactions::model::RawNotarizedTransaction;
use serde::{Deserialize, Serialize};

use crate::transaction::{Transaction, VmSpecificTxData};
use crate::{
    payload::{FullPayload, PayloadDetails},
    LanderError,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RadixTxPrecursor {
    pub raw_tx: Vec<u8>,
    pub tx_hash: H512,
}

pub trait Precursor {
    fn precursor(&self) -> &RadixTxPrecursor;
}

#[allow(clippy::panic)]
impl Precursor for Transaction {
    fn precursor(&self) -> &RadixTxPrecursor {
        match &self.vm_specific_data {
            VmSpecificTxData::Radix(precursor) => precursor,
            _ => panic!(),
        }
    }
}
