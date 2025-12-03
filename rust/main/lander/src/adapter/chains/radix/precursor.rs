use core_api_client::models::FeeSummary;
use ethers::{
    abi::Function,
    types::{transaction::eip2718::TypedTransaction, H160},
};
use radix_transactions::model::RawNotarizedTransaction;
use serde::{Deserialize, Serialize};

use hyperlane_core::H512;
use hyperlane_radix::RadixTxCalldata;

use crate::payload::{FullPayload, PayloadDetails};
use crate::transaction::{Transaction, VmSpecificTxData};
use crate::LanderError;

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
        #[allow(dead_code)]
        #[derive(Debug)]
        struct RadixTxPrecursorDebug<'a> {
            component_address: &'a str,
            method_name: &'a str,
            encoded_arguments_len: usize,
            visible_components: &'a Option<VisibleComponents>,
            fee_summary: &'a Option<FeeSummary>,
            tx_hash: &'a Option<H512>,
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

impl From<RadixTxPrecursor> for VmSpecificTxData {
    fn from(value: RadixTxPrecursor) -> Self {
        VmSpecificTxData::Radix(Box::new(value))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct VisibleComponents {
    pub addresses: Vec<String>,
}
