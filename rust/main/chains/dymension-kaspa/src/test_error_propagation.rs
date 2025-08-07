// Test module to demonstrate improved error propagation
#[cfg(test)]
mod test_error_propagation {
    use super::*;
    use dym_kas_core::deposit::DepositFXG;
    use dym_kas_validator::error::ValidationError;
    
    // Mock function to simulate validation error
    fn simulate_validation_error() -> Result<(), ValidationError> {
        Err(ValidationError::HLMessageFieldMismatch {
            field: "destination".to_string(),
            expected: "12345".to_string(),
            actual: "54321".to_string(),
        })
    }
    
    #[test]
    fn test_validation_error_message() {
        let result = simulate_validation_error();
        assert!(result.is_err());
        
        let error = result.unwrap_err();
        let error_msg = error.to_string();
        
        // The error message should contain specific details
        assert!(error_msg.contains("HL message field mismatch"));
        assert!(error_msg.contains("field=destination"));
        assert!(error_msg.contains("expected=12345"));
        assert!(error_msg.contains("actual=54321"));
        
        println!("Error message: {}", error_msg);
    }
    
    #[test]
    fn test_insufficient_deposit_error() {
        let error = ValidationError::InsufficientDepositAmount {
            required: "1000000".to_string(),
            actual: "500000".to_string(),
        };
        
        let error_msg = error.to_string();
        assert!(error_msg.contains("Insufficient deposit amount"));
        assert!(error_msg.contains("required=1000000"));
        assert!(error_msg.contains("actual=500000"));
        
        println!("Error message: {}", error_msg);
    }
    
    #[test]
    fn test_wrong_deposit_address_error() {
        let error = ValidationError::WrongDepositAddress {
            expected: "kaspa:qxxx...".to_string(),
            actual: "kaspa:qyyy...".to_string(),
        };
        
        let error_msg = error.to_string();
        assert!(error_msg.contains("Deposit not to escrow address"));
        assert!(error_msg.contains("expected=kaspa:qxxx..."));
        assert!(error_msg.contains("actual=kaspa:qyyy..."));
        
        println!("Error message: {}", error_msg);
    }
}