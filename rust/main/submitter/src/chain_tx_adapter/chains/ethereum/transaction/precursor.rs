use crate::chain_tx_adapter::EthereumTxPrecursor;
use crate::transaction::{Transaction, VmSpecificTxData};

pub trait Precursor {
    fn precursor(&self) -> &EthereumTxPrecursor;
}

impl Precursor for Transaction {
    fn precursor(&self) -> &EthereumTxPrecursor {
        match &self.vm_specific_data {
            VmSpecificTxData::Evm(precursor) => precursor,
            _ => panic!(),
        }
    }
}
