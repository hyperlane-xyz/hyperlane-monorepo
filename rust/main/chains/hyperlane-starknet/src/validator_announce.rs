#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{Announcement, Encode, SignedType, ValidatorAnnounce};
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, TxOutcome, H256, U256,
};
use starknet::accounts::{Account, Execution, SingleOwnerAccount};
use starknet::core::types::FieldElement;
use starknet::core::utils::{parse_cairo_short_string, ParseCairoShortStringError};
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::{instrument, warn};

use crate::contracts::validator_announce::ValidatorAnnounce as StarknetValidatorAnnounceInternal;
use crate::error::HyperlaneStarknetError;
use crate::types::{HyH256, HyU256};
use crate::utils::send_and_confirm;
use crate::{
    build_single_owner_account, string_to_cairo_long_string, to_strk_message_bytes, ConnectionConf,
    Signer, StarknetProvider,
};
use cainome::cairo_serde::EthAddress;

impl<A> std::fmt::Display for StarknetValidatorAnnounceInternal<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A reference to a ValidatorAnnounce contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetValidatorAnnounce {
    contract: StarknetValidatorAnnounceInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetValidatorAnnounce {
    /// Create a reference to a ValidatorAnnounce at a specific Starknet address on some
    /// chain
    pub fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Signer,
    ) -> ChainResult<Self> {
        let is_legacy = signer.version == 3;
        let account = build_single_owner_account(
            &conn.url,
            signer.local_wallet(),
            &signer.address,
            is_legacy,
            locator.domain.id(),
        );

        let va_address: FieldElement = HyH256(locator.address)
            .try_into()
            .map_err(HyperlaneStarknetError::BytesConversionError)?;

        let contract = StarknetValidatorAnnounceInternal::new(va_address, account);

        Ok(Self {
            contract,
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    /// Returns a ContractCall that processes the provided message.
    async fn announce_contract_call(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<(
        Execution<'_, SingleOwnerAccount<AnyProvider, LocalWallet>>,
        FieldElement,
    )> {
        let validator = FieldElement::from_byte_slice_be(&announcement.value.validator.to_vec())
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        let storage_location = string_to_cairo_long_string(&announcement.value.storage_location)
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        let signature_bytes = announcement.signature.to_vec();
        let signature = &to_strk_message_bytes(&signature_bytes);

        let tx = self
            .contract
            .announce(&EthAddress(validator), &storage_location, signature);
        let gas_estimate = tx
            .estimate_fee()
            .await
            .map_err(|e| {
                tracing::error!("Failed to estimate gas in announce_contract_call: {:?}", e);
                HyperlaneStarknetError::from(e)
            })?
            .overall_fee;

        let max_cost = gas_estimate * FieldElement::TWO;

        Ok((tx.max_fee(max_cost), max_cost))
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetValidatorAnnounceInternal<SingleOwnerAccount<AnyProvider, LocalWallet>> {
        &self.contract
    }
}

impl HyperlaneChain for StarknetValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetValidatorAnnounce {
    fn address(&self) -> H256 {
        HyH256::from(self.contract.address).0
    }
}

#[async_trait]
impl ValidatorAnnounce for StarknetValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let validators_calldata: Vec<EthAddress> = validators
            .iter()
            .map(|v| {
                TryInto::<FieldElement>::try_into(HyH256(*v))
                    .map_err(Into::<HyperlaneStarknetError>::into)
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(EthAddress)
            .collect();

        let storage_locations_res = self
            .contract
            .get_announced_storage_locations(&validators_calldata)
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        // In cairo, long strings are represented as an array of Field elements.
        // Storage locations is an array of long strings, so we just need to parse each
        // inner vector of Field elements into a string.
        let storage_locations = storage_locations_res
            .into_iter()
            .map(|validator_vec| {
                validator_vec
                    .into_iter()
                    .map(|inner_vec| {
                        inner_vec
                            .into_iter()
                            .map(|element| parse_cairo_short_string(&element))
                            .collect::<Result<Vec<String>, ParseCairoShortStringError>>()
                    })
                    .collect::<Result<Vec<Vec<String>>, ParseCairoShortStringError>>()
                    .map(|strings_vec| {
                        strings_vec
                            .into_iter()
                            .map(|inner_vec| inner_vec.join(""))
                            .collect::<Vec<String>>()
                    })
            })
            .collect::<Result<Vec<Vec<String>>, ParseCairoShortStringError>>()
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(storage_locations)
    }

    #[instrument(ret, skip(self))]
    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        _chain_signer: H256, // TODO: use chain signer instead of contract address
    ) -> Option<U256> {
        let Ok((_, max_cost)) = self.announce_contract_call(announcement).await else {
            warn!("Unable to get announce contract call");
            return None;
        };

        let Ok(balance) = self
            .provider
            .get_balance(self.contract.account.address().to_string())
            .await
        else {
            warn!("Unable to query balance");
            return None;
        };

        let max_cost_u256: HyU256 = max_cost.into();

        Some(max_cost_u256.0.saturating_sub(balance))
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let (contract_call, _) = self.announce_contract_call(announcement).await?;
        send_and_confirm(&self.provider.rpc_client(), contract_call).await
    }
}
