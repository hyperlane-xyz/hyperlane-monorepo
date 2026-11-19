use std::time::Duration;

use hyperlane_core::H256;
use tracing::warn;

/// Delay between fast polls for signatures.
pub const SIGNATURE_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Time after the first miss spent fast-polling for signatures.
pub const SIGNATURE_POLL_WINDOW: Duration = Duration::from_secs(10);
/// Delay applied after the message's retry budget has been exhausted.
pub const MESSAGE_RETRY_TERMINAL_DELAY: Duration = Duration::from_secs(10 * 7 * 24 * 60 * 60);

/// Accelerated signature delay before the ordinary retry schedule takes over.
pub fn signature_retry_delay(elapsed: Duration, backoff_retries: &mut u32) -> Option<Duration> {
    if *backoff_retries == 0 && elapsed < SIGNATURE_POLL_WINDOW {
        return Some(SIGNATURE_POLL_INTERVAL.min(SIGNATURE_POLL_WINDOW.saturating_sub(elapsed)));
    }
    *backoff_retries = backoff_retries.saturating_add(1);
    if *backoff_retries <= 3 {
        return Some(Duration::from_secs(u64::from(*backoff_retries)));
    }
    None
}

/// Delay for the given ordinary message retry count.
pub fn message_retry_delay(
    num_retries: u32,
    max_retries: u32,
    message_id: Option<H256>,
) -> Option<Duration> {
    Some(Duration::from_secs(match num_retries {
        i if i < 1 => return None,
        1 => 5,
        2 => 10,
        3 => 30,
        4 => 60,
        i if (5..25).contains(&i) => 60u64.saturating_mul(3),
        // linearly increase from 5min to ~25min, adding 1.5min for each additional attempt
        i if (25..40).contains(&i) => 60u64
            .saturating_mul(5)
            .saturating_add((i as u64).saturating_sub(25).saturating_mul(90)),
        // wait 30min for the next 5 attempts
        i if (40..45).contains(&i) => 60u64.saturating_mul(30),
        // wait 60min for the next 5 attempts
        i if (45..50).contains(&i) => 60u64.saturating_mul(60),
        // linearly increase the backoff time, adding 1h for each additional attempt
        i if (50..max_retries).contains(&i) => {
            let hour: u64 = 60u64.saturating_mul(60);
            let two_hours: u64 = hour.saturating_mul(2);
            // To be extra safe, `max` to make sure it's at least 2 hours.
            let target =
                two_hours.max((num_retries.saturating_sub(49) as u64).saturating_mul(two_hours));
            // Schedule it at some random point in the next 6 hours to
            // avoid scheduling messages with the same # of retries
            // at the exact same time and starve new messages.

            let six_hours = hour.saturating_mul(6);
            let random_val = rand::random::<u64>();
            target.saturating_add(random_val.overflowing_rem(six_hours).0)
        }
        // after `max_message_retries`, the message is considered undeliverable
        // and the backoff is set as far into the future as possible
        _ => {
            if let Some(message_id) = message_id {
                warn!(
                    message_id = ?message_id,
                    ?max_retries,
                    "Message has been retried too many times, skipping",
                );
            }
            MESSAGE_RETRY_TERMINAL_DELAY.as_secs()
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_schedule_joins_the_ordinary_message_schedule() {
        let mut accelerated = 0;
        for elapsed_ms in (0..10_000).step_by(500) {
            assert_eq!(
                signature_retry_delay(Duration::from_millis(elapsed_ms), &mut accelerated),
                Some(Duration::from_millis(500)),
            );
        }
        for (elapsed_seconds, delay_seconds) in [(10, 1), (11, 2), (13, 3)] {
            assert_eq!(
                signature_retry_delay(Duration::from_secs(elapsed_seconds), &mut accelerated),
                Some(Duration::from_secs(delay_seconds)),
            );
        }
        assert_eq!(
            signature_retry_delay(Duration::from_secs(16), &mut accelerated),
            None
        );

        for (retry, seconds) in [(1, 5), (2, 10), (3, 30), (4, 60), (5, 180)] {
            assert_eq!(
                message_retry_delay(retry, 51, None),
                Some(Duration::from_secs(seconds))
            );
        }
        let delay = message_retry_delay(50, 51, None).expect("retry has a delay");
        assert!((Duration::from_secs(7_200)..Duration::from_secs(28_800)).contains(&delay));
        assert_eq!(
            message_retry_delay(51, 51, None),
            Some(Duration::from_secs(10 * 7 * 24 * 60 * 60))
        );
    }
}
