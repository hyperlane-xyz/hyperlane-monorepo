use {
    crate::{ConnectionConf, DangoProvider, DangoResult, IntoDangoError},
    async_trait::async_trait,
    grug::BlockClient,
    hyperlane_core::{ChainResult, HyperlaneDomain, InterchainGasPayment, SequenceAwareIndexer},
};

#[derive(Debug)]
pub struct DangoIGP {
    pub provider: DangoProvider,
}

impl DangoIGP {
    pub fn new(config: &ConnectionConf, domain: &HyperlaneDomain) -> DangoResult<Self> {
        Ok(Self {
            provider: DangoProvider::from_config(config, domain, None)?,
        })
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for DangoIGP {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let height = self
            .provider
            .query_block(None)
            .await
            .into_dango_error()?
            .info
            .height;
        Ok((None, height as u32))
    }
}
