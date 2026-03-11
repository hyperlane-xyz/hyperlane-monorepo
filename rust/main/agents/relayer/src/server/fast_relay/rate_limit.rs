use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

/// Rate limiter configuration
#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    /// Maximum requests per window
    pub max_requests: usize,
    /// Time window for rate limiting
    pub window: Duration,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max_requests: 100,
            window: Duration::from_secs(60), // 100 requests per minute
        }
    }
}

/// Simple global rate limiter state
#[derive(Debug)]
struct RateLimiterState {
    /// Request timestamps (global, not per-IP for simplicity)
    requests: Vec<Instant>,
}

impl RateLimiterState {
    fn new() -> Self {
        Self {
            requests: Vec::new(),
        }
    }

    /// Check if request is allowed and record it
    fn check_and_record(&mut self, config: &RateLimitConfig) -> bool {
        let now = Instant::now();
        let cutoff = now - config.window;

        // Remove old requests outside the window
        self.requests.retain(|&timestamp| timestamp > cutoff);

        // Check if under limit
        if self.requests.len() < config.max_requests {
            self.requests.push(now);
            true
        } else {
            false
        }
    }

    /// Cleanup old entries to prevent memory growth
    fn cleanup(&mut self, config: &RateLimitConfig) {
        let now = Instant::now();
        let cutoff = now - config.window;
        self.requests.retain(|&timestamp| timestamp > cutoff);
    }
}

/// Rate limiter for fast relay endpoints
/// Uses simple global rate limiting (not per-IP) for Phase 1
#[derive(Clone)]
pub struct RateLimiter {
    state: Arc<RwLock<RateLimiterState>>,
    config: RateLimitConfig,
}

impl RateLimiter {
    /// Create a new rate limiter with default config
    pub fn new() -> Self {
        Self::with_config(RateLimitConfig::default())
    }

    /// Create a new rate limiter with custom config
    pub fn with_config(config: RateLimitConfig) -> Self {
        let limiter = Self {
            state: Arc::new(RwLock::new(RateLimiterState::new())),
            config,
        };

        // Spawn cleanup task
        let state = limiter.state.clone();
        let config = limiter.config.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(config.window);
            loop {
                interval.tick().await;
                state.write().await.cleanup(&config);
            }
        });

        limiter
    }

    /// Check if request is allowed
    pub async fn check(&self) -> bool {
        let mut state = self.state.write().await;
        state.check_and_record(&self.config)
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_limit() {
        let mut state = RateLimiterState::new();
        let config = RateLimitConfig {
            max_requests: 3,
            window: Duration::from_secs(60),
        };
        let ip: IpAddr = "127.0.0.1".parse().unwrap();

        // First 3 requests should be allowed
        assert!(state.check_and_record(ip, &config));
        assert!(state.check_and_record(ip, &config));
        assert!(state.check_and_record(ip, &config));

        // 4th request should be denied
        assert!(!state.check_and_record(ip, &config));
    }

    #[test]
    fn test_cleanup() {
        let mut state = RateLimiterState::new();
        let config = RateLimitConfig {
            max_requests: 5,
            window: Duration::from_millis(100),
        };
        let ip: IpAddr = "127.0.0.1".parse().unwrap();

        // Add requests
        state.check_and_record(ip, &config);
        state.check_and_record(ip, &config);

        assert_eq!(state.requests.get(&ip).unwrap().len(), 2);

        // Wait for window to expire
        std::thread::sleep(Duration::from_millis(150));

        // Cleanup should remove old entries
        state.cleanup(&config);
        assert!(state.requests.is_empty());
    }
}
