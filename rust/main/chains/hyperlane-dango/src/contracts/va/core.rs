use {
    crate::{
        hyperlane_contract, ConnectionConf, DangoConvertor, DangoError, DangoProvider, DangoResult,
        DangoSigner, TryDangoConvertor,
    },
    anyhow::anyhow,
    async_trait::async_trait,
    dango_hyperlane_types::va::{
        ExecuteMsg, QueryAnnounceFeePerByteRequest, QueryAnnouncedStorageLocationsRequest,
    },
    grug::{Coin, Inner, Message, Number, QueryClientExt, Uint128},
    hyperlane_core::{
        Announcement, ChainResult, ContractLocator, SignedType, TxOutcome, ValidatorAnnounce, H256,
        U256,
    },
    std::collections::BTreeSet,
};

#[derive(Debug)]
pub struct DangoValidatorAnnounce {
    provider: DangoProvider,
    address: H256,
}

impl DangoValidatorAnnounce {
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

    /// Calculate the fee for announcing a storage location.
    async fn announce_fee(&self, storage_location: &str) -> ChainResult<Coin> {
        let fee_per_byte = self
            .provider
            .query_wasm_smart(
                self.address.try_convert()?,
                QueryAnnounceFeePerByteRequest {},
                None,
            )
            .await?;

        let fee_amount = Uint128::new(fee_per_byte.amount.inner() * storage_location.len() as u128);

        Ok(Coin::new(fee_per_byte.denom, fee_amount)?)
    }

    async fn get_announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        signer: H256,
    ) -> ChainResult<U256> {
        let coins = self
            .announce_fee(&announcement.value.storage_location)
            .await?;

        let balance = self
            .provider
            .query_balance(signer.try_convert()?, coins.denom, None)
            .await?;

        Ok(coins.amount.saturating_sub(balance).into_inner().into())
    }
}

hyperlane_contract!(DangoValidatorAnnounce);

#[async_trait]
impl ValidatorAnnounce for DangoValidatorAnnounce {
    /// Returns the announced storage locations for the provided validators.
    async fn get_announced_storage_locations(
        &self,
        val_input: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let validators = val_input
            .iter()
            .map(|v| v.try_convert())
            .collect::<DangoResult<BTreeSet<_>>>()?;

        let response = self
            .provider
            .query_wasm_smart(
                self.address.try_convert()?,
                QueryAnnouncedStorageLocationsRequest { validators },
                None,
            )
            .await?;

        let mut buff = vec![];

        for validator in val_input {
            if let Some(locations) = response.get(&validator.try_convert()?) {
                buff.push(locations.clone().into_inner());
            } else {
                return Err(DangoError::Anyhow(anyhow!(
                    "location not found for validator {}",
                    validator
                )))?;
            }
        }

        Ok(buff)
    }

    /// Announce a storage location for a validator
    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        // To announce, the validator is required to pay some fee that depend from
        // the storage_location.
        let announce_fee = self
            .announce_fee(&announcement.value.storage_location)
            .await?;

        let msg = ExecuteMsg::Announce {
            validator: announcement.value.validator.convert(),
            storage_location: announcement.value.storage_location,
            signature: announcement.signature.to_vec().try_into()?,
        };

        let msg = Message::execute(self.address.try_convert()?, &msg, announce_fee).unwrap();

        Ok(self.provider.send_message_and_find(msg, None).await?)
    }

    /// Returns the number of additional tokens needed to pay for the announce
    /// transaction. Return `None` if the needed tokens cannot be determined.
    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        signer: H256,
    ) -> Option<U256> {
        self.get_announce_tokens_needed(announcement, signer)
            .await
            .ok()
    }
}
