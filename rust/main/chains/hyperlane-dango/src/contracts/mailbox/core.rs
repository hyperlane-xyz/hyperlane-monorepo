use {
    crate::{
        hyperlane_contract, ConnectionConf, DangoConvertor, DangoProvider, DangoResult,
        DangoSigner, TryDangoConvertor,
    },
    async_trait::async_trait,
    dango_hyperlane_types::{mailbox, recipients::RecipientQuery},
    grug::{Coins, HexBinary, Message, QueryClientExt},
    hyperlane_core::{
        ChainResult, ContractLocator, HyperlaneMessage, Mailbox, RawHyperlaneMessage, ReorgPeriod,
        TxCostEstimate, TxOutcome, H256, U256,
    },
};

#[derive(Debug)]
pub struct DangoMailbox {
    pub(crate) provider: DangoProvider,
    pub(crate) address: H256,
}

impl DangoMailbox {
    pub fn new(
        config: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<DangoSigner>,
    ) -> DangoResult<Self> {
        Ok(Self {
            provider: DangoProvider::from_config(config, locator.domain, signer)?,
            address: locator.address,
        })
    }
}

hyperlane_contract!(DangoMailbox);

#[async_trait]
impl Mailbox for DangoMailbox {
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        self.provider.validate_reorg_period(reorg_period).await?;
        Ok(self
            .provider
            .query_wasm_smart(
                self.address.try_convert()?,
                mailbox::QueryNonceRequest {},
                None,
            )
            .await?)
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        Ok(self
            .provider
            .query_wasm_smart(
                self.address.try_convert()?,
                mailbox::QueryDeliveredRequest {
                    message_id: id.convert(),
                },
                None,
            )
            .await?)
    }

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(self
            .provider
            .query_wasm_smart(
                self.address.try_convert()?,
                mailbox::QueryConfigRequest {},
                None,
            )
            .await?
            .default_ism
            .convert())
    }

    /// Get the latest checkpoint.
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        if let Some(ism) = self
            .provider
            .query_wasm_smart(
                recipient.try_convert()?,
                dango_hyperlane_types::recipients::QueryRecipientRequest(
                    RecipientQuery::InterchainSecurityModule {},
                ),
                None,
            )
            .await?
            .into_interchain_security_module()
        {
            Ok(ism.convert())
        } else {
            self.default_ism().await
        }
    }

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        Ok(self
            .provider
            .send_message_and_find(
                Message::execute(
                    self.address.try_convert()?,
                    &mailbox::ExecuteMsg::Process {
                        raw_message: HexBinary::from_inner(RawHyperlaneMessage::from(message)),
                        raw_metadata: HexBinary::from_inner(metadata.to_vec()),
                    },
                    Coins::default(),
                )?,
                tx_gas_limit.map(|limit| limit.try_into().unwrap()),
            )
            .await?)
    }

    /// Estimate transaction costs to process a message.
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        Ok(self
            .provider
            .estimate_costs(Message::execute(
                self.address.try_convert()?,
                &mailbox::ExecuteMsg::Process {
                    raw_message: HexBinary::from_inner(RawHyperlaneMessage::from(message)),
                    raw_metadata: HexBinary::from_inner(metadata.to_vec()),
                },
                Coins::default(),
            )?)
            .await?)
    }

    // not required.
    async fn process_calldata(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        todo!()
    }

    // not required.
    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}
