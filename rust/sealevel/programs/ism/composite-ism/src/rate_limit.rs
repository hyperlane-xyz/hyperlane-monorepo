/// Token bucket rate limiting, mirroring the algorithm in RateLimited.sol.

pub const DURATION_SECS: i64 = 86_400;

/// Computes the current filled level after time-based refill.
///
/// Mirrors `calculateCurrentLevel` in RateLimited.sol:
/// - If `elapsed >= 24h`: bucket fully resets to `max_capacity`
/// - Otherwise: refill proportionally to elapsed time at `max_capacity / DURATION_SECS` tokens/sec
///
/// Uses `u128` for intermediate multiplication to prevent overflow.
pub fn calculate_current_level(
    filled_level: u64,
    last_updated: i64,
    now: i64,
    max_capacity: u64,
) -> u64 {
    let elapsed = (now - last_updated).max(0);
    if elapsed >= DURATION_SECS {
        return max_capacity;
    }
    let refill = (elapsed as u128 * max_capacity as u128 / DURATION_SECS as u128) as u64;
    (filled_level + refill).min(max_capacity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_full_reset_at_duration() {
        assert_eq!(calculate_current_level(0, 0, DURATION_SECS, 1_000), 1_000);
    }

    #[test]
    fn test_full_reset_past_duration() {
        assert_eq!(
            calculate_current_level(0, 0, DURATION_SECS + 1, 1_000),
            1_000
        );
    }

    #[test]
    fn test_no_elapsed_no_refill() {
        assert_eq!(calculate_current_level(500, 100, 100, 1_000), 500);
    }

    #[test]
    fn test_partial_refill_half_day() {
        // Half a day elapsed: refill = 1000 * 43200 / 86400 = 500
        let result = calculate_current_level(0, 0, DURATION_SECS / 2, 1_000);
        assert_eq!(result, 500);
    }

    #[test]
    fn test_caps_at_max_capacity() {
        // filled_level near max + refill would exceed max: should cap
        let result = calculate_current_level(900, 0, DURATION_SECS / 2, 1_000);
        assert_eq!(result, 1_000);
    }

    #[test]
    fn test_max_capacity_below_duration_no_partial_refill() {
        // max_capacity = 1 < DURATION_SECS → refill_rate truncates to 0 per second
        // No partial refill, but full reset after 24h still works.
        assert_eq!(calculate_current_level(0, 0, 1, 1), 0);
        assert_eq!(calculate_current_level(0, 0, DURATION_SECS, 1), 1);
    }

    #[test]
    fn test_large_values_no_overflow() {
        let max = u64::MAX / 2;
        let result = calculate_current_level(0, 0, DURATION_SECS / 2, max);
        assert_eq!(result, max / 2);
    }

    #[test]
    fn test_negative_elapsed_clamped_to_zero() {
        // Clock went backwards: elapsed clamped to 0, no change.
        assert_eq!(calculate_current_level(500, 200, 100, 1_000), 500);
    }
}
