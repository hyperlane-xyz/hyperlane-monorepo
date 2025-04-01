use hyperlane_core::H512;

use crate::chain_tx_adapter::chains::sealevel::SealevelTxPrecursor;
use crate::transaction::{Transaction, VmSpecificTxData};

pub trait Update {
    fn update_after_submission(&mut self, hash: H512, precursor: SealevelTxPrecursor) -> &mut Self;
}

impl Update for Transaction {
    fn update_after_submission(&mut self, hash: H512, precursor: SealevelTxPrecursor) -> &mut Self {
        self.hash = Some(hash);
        self.submission_attempts += 1;

        // Data is updated since transaction is re-estimated before submission
        self.vm_specific_data = VmSpecificTxData::Svm(precursor);

        self
    }
}
