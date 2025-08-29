use {
    crate::{DangoProvider, DangoResult, DangoSigner},
    grug::Coin,
    hyperlane_core::{config::OpSubmissionConfig, HyperlaneDomain, HyperlaneProvider},
    url::Url,
};

/// Dango connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// httpd endpoint (not graphql)
    pub httpd_urls: Vec<Url>,
    /// Gas price
    pub gas_price: Coin,
    /// Gas scale
    pub gas_scale: f64,
    /// Flat gas increase
    pub flat_gas_increase: u64,
    /// Search sleep duration in seconds
    pub search_sleep_duration: u64,
    /// Search retry attempts
    pub search_retry_attempts: u64,
    pub chain_id: String,
    pub rpcs: Vec<Url>,
    pub operation_batch: OpSubmissionConfig,
}

impl ConnectionConf {
    /// Build a provider.
    pub fn build_provider(
        &self,
        domain: &HyperlaneDomain,
        signer: Option<DangoSigner>,
    ) -> DangoResult<Box<dyn HyperlaneProvider>> {
        Ok(Box::new(DangoProvider::from_config(self, domain, signer)?))
    }
}
