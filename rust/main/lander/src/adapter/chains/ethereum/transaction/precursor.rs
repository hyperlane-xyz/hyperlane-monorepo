use crate::adapter::EthereumTxPrecursor;
use crate::transaction::{Transaction, VmSpecificTxData};

pub trait Precursor {
    fn precursor(&self) -> &EthereumTxPrecursor;
    fn precursor_mut(&mut self) -> &mut EthereumTxPrecursor;
}

impl Precursor for Transaction {
    fn precursor(&self) -> &EthereumTxPrecursor {
        match &self.vm_specific_data {
            VmSpecificTxData::Evm(precursor) => precursor,
            _ => panic!(),
        }
    }

    fn precursor_mut(&mut self) -> &mut EthereumTxPrecursor {
        match &mut self.vm_specific_data {
            VmSpecificTxData::Evm(precursor) => precursor,
            _ => panic!(),
        }
    }
}
