use crate::{
    adapter::chains::sealevel::SealevelTxPrecursor,
    transaction::{Transaction, VmSpecificTxData},
};

pub trait Precursor {
    fn precursor(&self) -> &SealevelTxPrecursor;
}

impl Precursor for Transaction {
    fn precursor(&self) -> &SealevelTxPrecursor {
        match &self.vm_specific_data {
            VmSpecificTxData::Svm(precursor) => precursor,
            _ => panic!(),
        }
    }
}
