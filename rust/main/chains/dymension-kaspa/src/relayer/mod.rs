pub mod confirm;
pub mod deposit;
pub mod metrics;
pub mod migration;
pub mod withdraw;

// Re-export the main function for easier access
pub use migration::execute_migration;
pub use withdraw::messages::on_new_withdrawals;

// Re-export metrics for easier access
pub use metrics::KaspaBridgeMetrics;

pub use kaspa_bip32::secp256k1::PublicKey;
