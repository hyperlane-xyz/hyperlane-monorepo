use crate::{
    adapter::EthereumTxPrecursor,
    transaction::{Transaction, VmSpecificTxData},
};

pub trait Precursor {
    fn precursor(&self) -> &EthereumTxPrecursor;
    fn precursor_mut(&mut self) -> &mut EthereumTxPrecursor;
}

#[allow(clippy::panic)]
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
