use std::collections::HashSet;

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
        // only push hash if it doesn't exist in tx_hashes
        if !self.tx_hashes.contains(&hash) {
            self.tx_hashes.push(hash);
        }

        // Data is updated since transaction is re-estimated before submission
        self.vm_specific_data = VmSpecificTxData::Svm(Box::new(precursor));

        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        adapter::chains::sealevel::SealevelTxPrecursor,
        payload::PayloadDetails,
        transaction::{Transaction, VmSpecificTxData},
    };
    use hyperlane_core::{H256, H512};
    use hyperlane_sealevel::SealevelTxCostEstimate;
    use solana_sdk::{instruction::Instruction as SealevelInstruction, pubkey::Pubkey};

    fn create_test_precursor() -> SealevelTxPrecursor {
        let instruction = SealevelInstruction::new_with_bytes(Pubkey::new_unique(), &[], vec![]);
        let estimate = SealevelTxCostEstimate {
            compute_units: 200_000,
            compute_unit_price_micro_lamports: 1000,
        };
        SealevelTxPrecursor {
            instruction,
            estimate,
        }
    }

    fn create_test_transaction() -> Transaction {
        let precursor = create_test_precursor();
        let payload_details = vec![PayloadDetails {
            uuid: hyperlane_core::identifiers::UniqueIdentifier::random(),
            metadata: "test-payload".to_string(),
            success_criteria: None,
        }];
        Transaction::new(precursor, payload_details)
    }

    #[test]
    fn test_update_after_submission_adds_hash() {
        let mut tx = create_test_transaction();
        assert_eq!(tx.tx_hashes.len(), 0);

        let hash1 = H512::random();
        let precursor = create_test_precursor();
        tx.update_after_submission(hash1, precursor);

        assert_eq!(tx.tx_hashes.len(), 1);
        assert_eq!(tx.tx_hashes[0], hash1);
    }

    #[test]
    fn test_update_after_submission_deduplicates_hashes() {
        let mut tx = create_test_transaction();

        let hash1 = H512::random();
        let hash2 = H512::random();

        // Add first hash
        let precursor1 = create_test_precursor();
        tx.update_after_submission(hash1, precursor1);
        assert_eq!(tx.tx_hashes.len(), 1);

        // Add second hash
        let precursor2 = create_test_precursor();
        tx.update_after_submission(hash2, precursor2);
        assert_eq!(tx.tx_hashes.len(), 2);

        // Add duplicate of first hash - should deduplicate
        let precursor3 = create_test_precursor();
        tx.update_after_submission(hash1, precursor3);

        // Should still have 2 unique hashes, not 3
        assert_eq!(tx.tx_hashes.len(), 2);
        assert!(tx.tx_hashes.contains(&hash1));
        assert!(tx.tx_hashes.contains(&hash2));
    }

    #[test]
    fn test_update_after_submission_deduplicates_multiple_duplicates() {
        let mut tx = create_test_transaction();

        let hash1 = H512::random();
        let hash2 = H512::random();
        let hash3 = H512::random();

        // Add multiple hashes
        tx.update_after_submission(hash1, create_test_precursor());
        tx.update_after_submission(hash2, create_test_precursor());
        tx.update_after_submission(hash3, create_test_precursor());
        assert_eq!(tx.tx_hashes.len(), 3);

        // Add duplicates
        tx.update_after_submission(hash1, create_test_precursor());
        tx.update_after_submission(hash2, create_test_precursor());
        tx.update_after_submission(hash1, create_test_precursor());

        // Should still have 3 unique hashes
        assert_eq!(tx.tx_hashes.len(), 3);
        assert!(tx.tx_hashes.contains(&hash1));
        assert!(tx.tx_hashes.contains(&hash2));
        assert!(tx.tx_hashes.contains(&hash3));
    }

    #[test]
    fn test_update_after_submission_updates_vm_specific_data() {
        let mut tx = create_test_transaction();
        let _original_precursor = match &tx.vm_specific_data {
            VmSpecificTxData::Svm(p) => p.clone(),
            _ => panic!("Expected Svm variant"),
        };

        let hash = H512::random();
        let new_precursor = SealevelTxPrecursor {
            instruction: SealevelInstruction::new_with_bytes(
                Pubkey::new_unique(),
                &[1, 2, 3],
                vec![],
            ),
            estimate: SealevelTxCostEstimate {
                compute_units: 300_000,
                compute_unit_price_micro_lamports: 2000,
            },
        };

        tx.update_after_submission(hash, new_precursor.clone());

        match &tx.vm_specific_data {
            VmSpecificTxData::Svm(p) => {
                assert_eq!(p.estimate.compute_units, 300_000);
                assert_eq!(p.estimate.compute_unit_price_micro_lamports, 2000);
            }
            _ => panic!("Expected Svm variant"),
        }
    }
}
