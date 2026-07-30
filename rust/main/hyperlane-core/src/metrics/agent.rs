use crate::HyperlaneDomainProtocol;
use std::time::Duration;

#[cfg(feature = "float")]
use crate::U256;

const ETHEREUM_DECIMALS: u8 = 18;
const COSMOS_DECIMALS: u8 = 6;
const SOLANA_DECIMALS: u8 = 9;
const ALEO_DECIMALS: u8 = 6;

/// Interval for querying the prometheus metrics endpoint.
/// This should be whatever the prometheus scrape interval is
pub const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);

/// Convert a u256 scaled integer value into the corresponding f64 value, using
/// the protocol's default number of native token decimals.
#[cfg(feature = "float")]
pub fn u256_as_scaled_f64(value: U256, domain: HyperlaneDomainProtocol) -> f64 {
    u256_as_scaled_f64_with_decimals(value, decimals_by_protocol(domain) as u32)
}

/// Convert a u256 scaled integer value into the corresponding f64 value, using
/// the provided number of decimals.
#[cfg(feature = "float")]
pub fn u256_as_scaled_f64_with_decimals(value: U256, decimals: u32) -> f64 {
    value.to_f64_lossy() / 10f64.powi(decimals as i32)
}

/// Get the decimals each protocol typically uses for its lowest denomination
/// of the native token
pub fn decimals_by_protocol(protocol: HyperlaneDomainProtocol) -> u8 {
    match protocol {
        HyperlaneDomainProtocol::Cosmos | HyperlaneDomainProtocol::CosmosNative => COSMOS_DECIMALS,
        HyperlaneDomainProtocol::Sealevel => SOLANA_DECIMALS,
        HyperlaneDomainProtocol::Aleo => ALEO_DECIMALS,
        _ => ETHEREUM_DECIMALS,
    }
}

#[cfg(all(test, feature = "float"))]
mod tests {
    use super::*;

    #[test]
    fn scales_by_configured_decimals() {
        // 1152 TRX at 6 decimals (Tron) = 1_152_000_000 SUN.
        let tron_balance = U256::from(1_152_000_000u64);
        assert!((u256_as_scaled_f64_with_decimals(tron_balance, 6) - 1152.0).abs() < 1e-9);

        // 1.5 ETH at 18 decimals.
        let eth_balance = U256::from(1_500_000_000_000_000_000u64);
        assert!((u256_as_scaled_f64_with_decimals(eth_balance, 18) - 1.5).abs() < 1e-9);
    }
}
