use std::fmt::Debug;

use core_api_client::models::FeeSummary;
use ethers::{
    abi::Function,
    types::{transaction::eip2718::TypedTransaction, H160},
};
use hyperlane_core::H512;
use hyperlane_radix::RadixProcessCalldata;
use radix_transactions::model::RawNotarizedTransaction;
use serde::{Deserialize, Serialize};

use crate::transaction::{Transaction, VmSpecificTxData};
use crate::{
    payload::{FullPayload, PayloadDetails},
    LanderError,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RadixTxPrecursor {
    /// Address of mailbox (already encoded)
    pub component_address: String,
    /// Method to call on mailbox
    pub method_name: String,
    /// parameters required to call method
    pub encoded_arguments: Vec<u8>,
    /// fee summary
    pub fee_summary: FeeSummary,
    /// tx hash
    pub tx_hash: Option<H512>,
}

impl std::cmp::Eq for RadixTxPrecursor {}

impl From<RadixProcessCalldata> for RadixTxPrecursor {
    fn from(value: RadixProcessCalldata) -> Self {
        Self {
            component_address: value.component_address,
            method_name: value.method_name,
            encoded_arguments: value.encoded_arguments,
            fee_summary: value.fee_summary,
            tx_hash: value.tx_hash,
        }
    }
}

pub trait Precursor {
    fn precursor(&self) -> &RadixTxPrecursor;
    fn precursor_mut(&mut self) -> &mut RadixTxPrecursor;
}

#[allow(clippy::panic)]
impl Precursor for Transaction {
    fn precursor(&self) -> &RadixTxPrecursor {
        match &self.vm_specific_data {
            VmSpecificTxData::Radix(precursor) => precursor,
            _ => panic!(),
        }
    }
    fn precursor_mut(&mut self) -> &mut RadixTxPrecursor {
        match &mut self.vm_specific_data {
            VmSpecificTxData::Radix(precursor) => precursor,
            _ => panic!(),
        }
    }
}
