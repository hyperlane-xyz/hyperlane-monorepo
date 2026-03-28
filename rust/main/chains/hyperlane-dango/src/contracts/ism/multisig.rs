use {
    super::DangoIsm,
    crate::{DangoConvertor, TryDangoConvertor},
    async_trait::async_trait,
    dango_hyperlane_types::isms,
    grug::QueryClientExt,
    hyperlane_core::{ChainResult, HyperlaneMessage, MultisigIsm, H256},
};

#[async_trait]
impl MultisigIsm for DangoIsm {
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let res = self
            .provider
            .query_wasm_smart(
                self.address.try_convert()?,
                isms::multisig::QueryValidatorSetRequest {
                    domain: message.origin,
                },
                None,
            )
            .await?;

        let validators: Vec<H256> = res
            .validators
            .into_iter()
            .map(DangoConvertor::convert)
            .collect();

        Ok((validators, res.threshold as u8))
    }
}
