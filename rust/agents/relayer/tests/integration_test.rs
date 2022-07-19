use abacus_core::CommittedMessage;
use ethers::types::{H160, H256};
use ethers::utils::hex;

/// This doesn't do anything yet, but the future is bright.
#[test]
fn integration_test() {
    let _cm = CommittedMessage {
        leaf_index: 13,
        message: abacus_core::AbacusMessage {
            origin: 1,
            sender: H160::from_low_u64_be(1).into(),
            destination: 2,
            recipient: H256::from_low_u64_be(2),
            body: hex::decode("deadbeef").unwrap(),
        },
    };
}
