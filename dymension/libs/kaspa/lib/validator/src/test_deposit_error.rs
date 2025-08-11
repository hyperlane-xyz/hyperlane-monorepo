use crate::error::ValidationError;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deposit_not_final_error() {
        let error = ValidationError::NotSafeAgainstReorg {
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
        let not_final = ValidationError::NotSafeAgainstReorg {
            tx_id: "tx_123".to_string(),
            confirmations: 2,
            required: 10,
        };

        // Error messages check
        assert!(not_accepted.to_string().contains("not safe against reorg"));
    }
}