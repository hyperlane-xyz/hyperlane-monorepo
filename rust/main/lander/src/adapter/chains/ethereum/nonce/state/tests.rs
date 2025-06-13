use ethers_core::types::Address;

use hyperlane_core::U256;

use crate::adapter::EthereumTxPrecursor;
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData};

#[allow(deprecated)]
pub fn make_tx(
    uuid: TransactionUuid,
    status: TransactionStatus,
    nonce: Option<U256>,
    address: Option<Address>,
) -> Transaction {
    use ethers_core::abi::Function;
    let mut precursor = EthereumTxPrecursor {
        tx: Default::default(),
        function: Function {
            name: "".to_string(),
            inputs: vec![],
            outputs: vec![],
            constant: None,
            state_mutability: Default::default(),
        },
    };
    if let Some(n) = nonce {
        precursor.tx.set_nonce(n);
    }
    if let Some(addr) = address {
        precursor.tx.set_from(addr);
    }
    Transaction {
        uuid,
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Evm(precursor),
        payload_details: vec![],
        status,
        submission_attempts: 0,
        creation_timestamp: Default::default(),
        last_submission_attempt: None,
    }
}
