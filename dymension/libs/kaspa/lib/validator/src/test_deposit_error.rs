use crate::error::ValidationError;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deposit_not_final_error() {
        let error = ValidationError::DepositNotFinal {
            tx_id: "test_tx_123".to_string(),
            confirmations: 5,
            required: 10,
        };

        let error_string = error.to_string();
        assert!(error_string.contains("test_tx_123"));
        assert!(error_string.contains("confirmations=5"));
        assert!(error_string.contains("required=10"));
        assert!(error_string.contains("Deposit transaction is not final"));
    }

    #[test]
    fn test_not_safe_against_reorg_vs_not_final() {
        let not_final = ValidationError::DepositNotFinal {
            tx_id: "tx_123".to_string(),
            confirmations: 2,
            required: 10,
        };

        let not_accepted = ValidationError::NotSafeAgainstReorg {
            tx_id: "tx_123".to_string(),
        };

        // These should be different error types
        match not_final {
            ValidationError::DepositNotFinal { .. } => {}
            _ => panic!("Expected DepositNotFinal"),
        }

        match not_accepted {
            ValidationError::NotSafeAgainstReorg { .. } => {}
            _ => panic!("Expected NotSafeAgainstReorg"),
        }

        // Error messages should be different
        assert!(not_final.to_string().contains("not final"));
        assert!(not_accepted.to_string().contains("not safe against reorg"));
    }
}