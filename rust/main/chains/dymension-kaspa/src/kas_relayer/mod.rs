pub mod confirm;
pub mod deposit;
pub mod metrics;
pub mod withdraw;

// Re-export the main function for easier access
pub use withdraw::messages::on_new_withdrawals;

// Re-export metrics for easier access
pub use metrics::KaspaBridgeMetrics;
