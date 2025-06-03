#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{Announcement, Encode, SignedType, ValidatorAnnounce};
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, TxOutcome, H256, U256,
};
use starknet::accounts::{ExecutionV3, SingleOwnerAccount};
use starknet::core::types::Felt;
use starknet::core::utils::{parse_cairo_short_string, ParseCairoShortStringError};
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::validator_announce::ValidatorAnnounce as StarknetValidatorAnnounceInternal;
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::utils::send_and_confirm;
use crate::{
    build_single_owner_account, string_to_cairo_long_string, ConnectionConf, Signer,
    StarknetProvider,
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
    pub async fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator<'_>,
        signer: Signer,
    ) -> ChainResult<Self> {
        let account = build_single_owner_account(
            &conn.url,
            signer.local_wallet(),
            &signer.address,
            signer.is_legacy,
        )
        .await?;

        let va_address: Felt = HyH256(locator.address).into();

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
    ) -> ChainResult<ExecutionV3<'_, SingleOwnerAccount<AnyProvider, LocalWallet>>> {
        let validator = Felt::from_bytes_be_slice(&announcement.value.validator.to_vec());
        let storage_location = string_to_cairo_long_string(&announcement.value.storage_location)
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        let signature_bytes = announcement.signature.to_vec();
        let signature = signature_bytes.as_slice().into();

        let tx = self
            .contract
            .announce(&EthAddress(validator), &storage_location, &signature);

        Ok(tx)
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
            .map(|v| Into::<Felt>::into(HyH256(*v)))
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
        _announcement: SignedType<Announcement>,
        _chain_signer: H256, // TODO: use chain signer instead of contract address
    ) -> Option<U256> {
        // we just gonna assume that the announce_tokens_needed is always 0
        return Some(U256::zero());
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let contract_call = self.announce_contract_call(announcement).await?;
        send_and_confirm(&self.provider.rpc_client(), contract_call).await
    }
}
