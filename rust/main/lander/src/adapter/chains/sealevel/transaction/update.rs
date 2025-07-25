use hyperlane_core::H512;

use crate::{
    adapter::chains::sealevel::SealevelTxPrecursor,
    transaction::{Transaction, VmSpecificTxData},
};

pub trait Update {
    fn update_after_submission(&mut self, hash: H512, precursor: SealevelTxPrecursor) -> &mut Self;
}

impl Update for Transaction {
    fn update_after_submission(&mut self, hash: H512, precursor: SealevelTxPrecursor) -> &mut Self {
        self.tx_hashes.push(hash);

        // Data is updated since transaction is re-estimated before submission
        self.vm_specific_data = VmSpecificTxData::Svm(precursor);

        self
    }
}
