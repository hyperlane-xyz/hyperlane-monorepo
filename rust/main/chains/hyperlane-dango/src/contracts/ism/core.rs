use {
    crate::{
        hyperlane_contract, ConnectionConf, DangoProvider, DangoResult, DangoSigner,
        TryDangoConvertor,
    },
    async_trait::async_trait,
    dango_hyperlane_types::isms,
    grug::QueryClientExt,
    hyperlane_core::{
        ChainResult, ContractLocator, HyperlaneMessage, InterchainSecurityModule, ModuleType,
        RawHyperlaneMessage, H256, U256,
    },
};

#[derive(Debug)]
pub struct DangoIsm {
    pub(crate) provider: DangoProvider,
    pub(crate) address: H256,
}

impl DangoIsm {
    pub fn new(
        config: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<DangoSigner>,
    ) -> DangoResult<Self> {
        Ok(Self {
            address: locator.address,
            provider: DangoProvider::from_config(config, locator.domain, signer)?,
        })
    }
}

hyperlane_contract!(DangoIsm);

#[async_trait]
impl InterchainSecurityModule for DangoIsm {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        Ok(ModuleType::MessageIdMultisig)
    }

    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        self.provider
            .query_wasm_smart(
                self.address.try_convert()?,
                isms::multisig::QueryIsmRequest(isms::IsmQuery::Verify {
                    raw_message: RawHyperlaneMessage::from(message).into(),
                    raw_metadata: metadata.to_vec().into(),
                }),
                None,
            )
            .await?;

        // We don't have a way to estimate gas for this call, so we return a default value
        Ok(Some(U256::one()))
    }
}
