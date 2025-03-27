use hyperlane_core::H512;

use crate::chain_tx_adapter::chains::sealevel::SealevelTxPrecursor;
use crate::transaction::{Transaction, VmSpecificTxData};

pub trait Update {
    fn update_after_submission(&mut self, hash: H512, precursor: SealevelTxPrecursor) -> &mut Self;
}

impl Update for Transaction {
    fn update_after_submission(&mut self, hash: H512, precursor: SealevelTxPrecursor) -> &mut Self {
        self.hash = Some(hash);
        self.vm_specific_data = VmSpecificTxData::Svm(precursor);
        self.submission_attempts += 1;
        self
    }
}
