use crate::types::FeeEstimate;

#[test]
fn test_fee_estimate_new() {
    let fee = FeeEstimate::new(1000, 100);
    assert_eq!(fee.base_fee, 1000);
    assert_eq!(fee.priority_fee, 100);
    assert_eq!(fee.total_fee, 1100);
}

#[test]
fn test_fee_estimate_new_zero_fees() {
    let fee = FeeEstimate::new(0, 0);
    assert_eq!(fee.base_fee, 0);
    assert_eq!(fee.priority_fee, 0);
    assert_eq!(fee.total_fee, 0);
}

#[test]
fn test_fee_estimate_new_zero_priority() {
    let fee = FeeEstimate::new(1000, 0);
    assert_eq!(fee.base_fee, 1000);
    assert_eq!(fee.priority_fee, 0);
    assert_eq!(fee.total_fee, 1000);
}

#[test]
fn test_fee_estimate_new_large_values() {
    let base_fee = 1_000_000_000u64;
    let priority_fee = 500_000_000u64;
    let fee = FeeEstimate::new(base_fee, priority_fee);
    assert_eq!(fee.base_fee, base_fee);
    assert_eq!(fee.priority_fee, priority_fee);
    assert_eq!(fee.total_fee, base_fee + priority_fee);
}

#[test]
fn test_fee_estimate_new_saturating_add() {
    // Test that saturating_add prevents overflow
    let base_fee = u64::MAX - 100;
    let priority_fee = 200;
    let fee = FeeEstimate::new(base_fee, priority_fee);
    assert_eq!(fee.base_fee, base_fee);
    assert_eq!(fee.priority_fee, priority_fee);
    // Should saturate at u64::MAX instead of overflowing
    assert_eq!(fee.total_fee, u64::MAX);
}

#[test]
fn test_fee_estimate_new_max_values() {
    // Test edge case with max values
    let fee = FeeEstimate::new(u64::MAX, u64::MAX);
    assert_eq!(fee.base_fee, u64::MAX);
    assert_eq!(fee.priority_fee, u64::MAX);
    assert_eq!(fee.total_fee, u64::MAX); // Should saturate at u64::MAX
}

#[test]
fn test_fee_estimate_equality() {
    let fee1 = FeeEstimate::new(1000, 100);
    let fee2 = FeeEstimate::new(1000, 100);
    assert_eq!(fee1, fee2);
}

#[test]
fn test_fee_estimate_inequality() {
    let fee1 = FeeEstimate::new(1000, 100);
    let fee2 = FeeEstimate::new(1000, 200);
    let fee3 = FeeEstimate::new(2000, 100);
    assert_ne!(fee1, fee2);
    assert_ne!(fee1, fee3);
}

#[test]
fn test_fee_estimate_clone() {
    let fee1 = FeeEstimate::new(1000, 100);
    let fee2 = fee1.clone();
    assert_eq!(fee1, fee2);
}

#[test]
fn test_fee_estimate_debug() {
    let fee = FeeEstimate::new(1000, 100);
    let debug_str = format!("{:?}", fee);
    assert!(debug_str.contains("1000"));
    assert!(debug_str.contains("100"));
    assert!(debug_str.contains("1100"));
}

#[test]
fn test_fee_estimate_serde_roundtrip() {
    let original = FeeEstimate::new(1000, 100);
    let serialized = serde_json::to_string(&original).expect("Failed to serialize");
    let deserialized: FeeEstimate =
        serde_json::from_str(&serialized).expect("Failed to deserialize");
    assert_eq!(original, deserialized);
}

#[test]
fn test_fee_estimate_serde_json_format() {
    let fee = FeeEstimate::new(1000, 100);
    let serialized = serde_json::to_string(&fee).expect("Failed to serialize");
    // Verify JSON contains all three fields
    assert!(serialized.contains("\"base_fee\":1000"));
    assert!(serialized.contains("\"priority_fee\":100"));
    assert!(serialized.contains("\"total_fee\":1100"));
}
