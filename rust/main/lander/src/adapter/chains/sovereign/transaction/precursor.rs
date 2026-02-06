use crate::{
    adapter::chains::sovereign::SovereignTxPrecursor,
    transaction::{Transaction, VmSpecificTxData},
};

pub trait Precursor {
    fn precursor(&self) -> &SovereignTxPrecursor;
    fn precursor_mut(&mut self) -> &mut SovereignTxPrecursor;
}

#[allow(clippy::panic)]
impl Precursor for Transaction {
    fn precursor(&self) -> &SovereignTxPrecursor {
        match &self.vm_specific_data {
            VmSpecificTxData::Sovereign(precursor) => precursor,
            _ => panic!(),
        }
    }
    fn precursor_mut(&mut self) -> &mut SovereignTxPrecursor {
        match &mut self.vm_specific_data {
            VmSpecificTxData::Sovereign(precursor) => precursor,
            _ => panic!(),
        }
    }
}
