use std::fmt::Debug;

use core_api_client::models::FeeSummary;
use ethers::{
    abi::Function,
    types::{transaction::eip2718::TypedTransaction, H160},
};
use radix_transactions::model::RawNotarizedTransaction;
use serde::{Deserialize, Serialize};

use hyperlane_core::H512;
use hyperlane_radix::RadixTxCalldata;

use crate::transaction::{Transaction, VmSpecificTxData};
use crate::{
    payload::{FullPayload, PayloadDetails},
    LanderError,
};

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub struct RadixTxPrecursor {
    /// Address of contract to interact with
    pub component_address: String,
    /// Method to call on contract
    pub method_name: String,
    /// parameters required to call method
    pub encoded_arguments: Vec<u8>,
    /// addresses needed to pass to tx
    pub visible_components: Option<VisibleComponents>,
    /// fee summary
    pub fee_summary: Option<FeeSummary>,
    /// tx hash
    pub tx_hash: Option<H512>,
}

impl std::fmt::Debug for RadixTxPrecursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        #[derive(Debug)]
        struct RadixTxPrecursorDebug<'a> {
            pub component_address: &'a str,
            pub method_name: &'a str,
            pub encoded_arguments_len: usize,
            pub visible_components: &'a Option<VisibleComponents>,
            pub fee_summary: &'a Option<FeeSummary>,
            pub tx_hash: &'a Option<H512>,
        }

        let Self {
            component_address,
            method_name,
            encoded_arguments,
            visible_components,
            fee_summary,
            tx_hash,
        } = self;
        std::fmt::Debug::fmt(
            &RadixTxPrecursorDebug {
                component_address,
                method_name,
                encoded_arguments_len: encoded_arguments.len(),
                visible_components,
                fee_summary,
                tx_hash,
            },
            f,
        )
    }
}

impl RadixTxPrecursor {
    pub fn new(component_address: String, method_name: String, encoded_arguments: Vec<u8>) -> Self {
        Self {
            component_address,
            method_name,
            encoded_arguments,
            visible_components: None,
            fee_summary: None,
            tx_hash: None,
        }
    }
}

impl std::cmp::Eq for RadixTxPrecursor {}

impl From<RadixTxCalldata> for RadixTxPrecursor {
    fn from(value: RadixTxCalldata) -> Self {
        Self {
            component_address: value.component_address,
            method_name: value.method_name,
            encoded_arguments: value.encoded_arguments,
            visible_components: None,
            fee_summary: None,
            tx_hash: None,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct VisibleComponents {
    pub addresses: Vec<String>,
}
