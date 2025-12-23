use crate::adapter::RadixTxPrecursor;
use crate::transaction::{Transaction, VmSpecificTxData};

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
