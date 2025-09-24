use std::{sync::Arc, time::Duration};

use hyperlane_radix::RadixSigner;
use scrypto::network::NetworkDefinition;

use crate::{
    adapter::chains::radix::{adapter::RadixAdapter, tests::MockRadixProvider},
    transaction::VmSpecificTxData,
    FullPayload,
};

// random private key used for testing
pub const TEST_PRIVATE_KEY: &str =
    "E99BC4A79BCE79A990322FBE97E2CEFF85C5DB7B39C495215B6E2C7020FD103D";
pub const MAILBOX_ADDRESS: &str =
    "component_rdx1cpcq2wcs8zmpjanjf5ek76y4wttdxswnyfcuhynz4zmhjfjxqfsg9z";

pub fn adapter(provider: Arc<MockRadixProvider>, signer: RadixSigner) -> RadixAdapter {
    let private_key = signer.get_signer().expect("Failed to get private key");
    RadixAdapter {
        provider,
        network: NetworkDefinition::mainnet(),
        private_key,
        signer,
        estimated_block_time: Duration::from_nanos(0),
        component_regex: regex::Regex::new("").unwrap(),
    }
}

pub fn payload(process_calldata: Vec<u8>) -> FullPayload {
    let payload = FullPayload {
        data: process_calldata,
        ..Default::default()
    };
    payload
}
