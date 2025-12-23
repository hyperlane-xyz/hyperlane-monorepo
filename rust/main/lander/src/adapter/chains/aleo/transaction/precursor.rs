use crate::transaction::{Transaction, VmSpecificTxData};

use super::super::AleoTxPrecursor;

pub trait Precursor {
    fn precursor(&self) -> &AleoTxPrecursor;

    #[cfg(test)]
    fn precursor_mut(&mut self) -> &mut AleoTxPrecursor;
}

#[allow(clippy::panic)]
impl Precursor for Transaction {
    fn precursor(&self) -> &AleoTxPrecursor {
        match &self.vm_specific_data {
            VmSpecificTxData::Aleo(precursor) => precursor,
            _ => panic!(),
        }
    }

    #[cfg(test)]
    fn precursor_mut(&mut self) -> &mut AleoTxPrecursor {
        match &mut self.vm_specific_data {
            VmSpecificTxData::Aleo(precursor) => precursor,
            _ => panic!(),
        }
    }
}
