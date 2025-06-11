use std::{ops::RangeInclusive, sync::Arc};

use async_trait::async_trait;
use derive_new::new;
use hyperlane_sealevel_igp::{
    accounts::{GasPaymentAccount, ProgramDataAccount},
    igp_gas_payment_pda_seeds, igp_program_data_pda_seeds,
};
use solana_sdk::{account::Account, clock::Slot, pubkey::Pubkey};
use tracing::{info, instrument};

use hyperlane_core::{
    config::StrOrIntParseError, ChainCommunicationError, ChainResult, ContractLocator,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider, Indexed, Indexer,
    InterchainGasPaymaster, InterchainGasPayment, LogMeta, SequenceAwareIndexer, H256, H512, U256,
};

use crate::account::{search_accounts_by_discriminator, search_and_validate_account};
use crate::fallback::SubmitSealevelRpc;
use crate::log_meta_composer::{is_interchain_payment_instruction, LogMetaComposer};
use crate::SealevelProvider;

/// The offset to get the `unique_gas_payment_pubkey` field from the serialized GasPaymentData.
/// The account data includes prefixes that are accounted for here: a 1 byte initialized flag
/// and an 8 byte discriminator.
const UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET: usize = 1 + 8 + 8 + 32 + 4 + 32 + 8 + 8;

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {
    program_id: Pubkey,
    data_pda_pubkey: Pubkey,
    domain: HyperlaneDomain,
    igp_account: H256,
    provider: Arc<SealevelProvider>,
}

impl SealevelInterchainGasPaymaster {
    /// Create a new Sealevel IGP.
    pub async fn new(
        provider: Arc<SealevelProvider>,
        igp_account_locator: &ContractLocator<'_>,
    ) -> ChainResult<Self> {
        let program_id =
            Self::determine_igp_program_id(&provider, &igp_account_locator.address).await?;
        let (data_pda_pubkey, _) =
            Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);

        Ok(Self {
            program_id,
            data_pda_pubkey,
            domain: igp_account_locator.domain.clone(),
            igp_account: igp_account_locator.address,
            provider,
        })
    }

    async fn determine_igp_program_id(
        provider: &Arc<SealevelProvider>,
        igp_account_pubkey: &H256,
    ) -> ChainResult<Pubkey> {
        let account = provider
            .rpc_client()
            .get_account_with_finalized_commitment(Pubkey::from(<[u8; 32]>::from(
                *igp_account_pubkey,
            )))
            .await?;
        Ok(account.owner)
    }
}

impl HyperlaneContract for SealevelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl InterchainGasPaymaster for SealevelInterchainGasPaymaster {}

/// Struct that retrieves event data for a Sealevel IGP contract
#[derive(Debug)]
pub struct SealevelInterchainGasPaymasterIndexer {
    provider: Arc<SealevelProvider>,
    igp: SealevelInterchainGasPaymaster,
    log_meta_composer: LogMetaComposer,
    advanced_log_meta: bool,
}

/// IGP payment data on Sealevel
#[derive(Debug, new)]
pub struct SealevelGasPayment {
    payment: Indexed<InterchainGasPayment>,
    log_meta: LogMeta,
    igp_account_pubkey: H256,
}

impl SealevelInterchainGasPaymasterIndexer {
    /// Create a new Sealevel IGP indexer.
    pub async fn new(
        provider: Arc<SealevelProvider>,
        igp_account_locator: ContractLocator<'_>,
        advanced_log_meta: bool,
    ) -> ChainResult<Self> {
        let igp =
            SealevelInterchainGasPaymaster::new(provider.clone(), &igp_account_locator).await?;

        let log_meta_composer = LogMetaComposer::new(
            igp.program_id,
            "interchain gas payment".to_owned(),
            is_interchain_payment_instruction,
        );

        Ok(Self {
            provider,
            igp,
            log_meta_composer,
            advanced_log_meta,
        })
    }

    #[instrument(err, skip(self))]
    async fn get_payment_with_sequence(
        &self,
        sequence_number: u64,
    ) -> ChainResult<SealevelGasPayment> {
        let discriminator = hyperlane_sealevel_igp::accounts::GAS_PAYMENT_DISCRIMINATOR;
        let sequence_number_bytes = sequence_number.to_le_bytes();
        let unique_gas_payment_pubkey_length = 32; // the length of the `unique_gas_payment_pubkey` field
        let accounts = search_accounts_by_discriminator(
            &self.provider,
            &self.igp.program_id,
            discriminator,
            &sequence_number_bytes,
            UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET,
            unique_gas_payment_pubkey_length,
        )
        .await?;

        tracing::debug!(accounts=?accounts, "Fetched program accounts");

        let valid_payment_pda_pubkey = search_and_validate_account(accounts, |account| {
            self.interchain_payment_account(account)
        })?;

        // Now that we have the valid gas payment PDA pubkey, we can get the full account data.
        let account = self
            .provider
            .rpc_client()
            .get_account_with_finalized_commitment(valid_payment_pda_pubkey)
            .await?;
        let gas_payment_account = GasPaymentAccount::fetch(&mut account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        tracing::debug!(gas_payment_account=?gas_payment_account, "Found gas payment account");

        let igp_payment = InterchainGasPayment {
            message_id: gas_payment_account.message_id,
            destination: gas_payment_account.destination_domain,
            payment: gas_payment_account.payment.into(),
            gas_amount: gas_payment_account.gas_amount.into(),
        };

        let log_meta = if self.advanced_log_meta {
            self.interchain_payment_log_meta(
                U256::from(sequence_number),
                &valid_payment_pda_pubkey,
                &gas_payment_account.slot,
            )
            .await?
        } else {
            LogMeta {
                address: self.igp.program_id.to_bytes().into(),
                block_number: gas_payment_account.slot,
                // TODO: get these when building out scraper support.
                // It's inconvenient to get these :|
                block_hash: H256::zero(),
                transaction_id: H512::zero(),
                transaction_index: 0,
                log_index: sequence_number.into(),
            }
        };

        Ok(SealevelGasPayment::new(
            Indexed::new(igp_payment).with_sequence(
                sequence_number
                    .try_into()
                    .map_err(StrOrIntParseError::from)?,
            ),
            log_meta,
            H256::from(gas_payment_account.igp.to_bytes()),
        ))
    }

    fn interchain_payment_account(&self, account: &Account) -> ChainResult<Pubkey> {
        let unique_gas_payment_pubkey = Pubkey::new(&account.data);
        let (expected_pubkey, _bump) = Pubkey::try_find_program_address(
            igp_gas_payment_pda_seeds!(unique_gas_payment_pubkey),
            &self.igp.program_id,
        )
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "Could not find program address for unique_gas_payment_pubkey",
            )
        })?;
        Ok(expected_pubkey)
    }

    async fn interchain_payment_log_meta(
        &self,
        log_index: U256,
        payment_pda_pubkey: &Pubkey,
        payment_pda_slot: &Slot,
    ) -> ChainResult<LogMeta> {
        let block = self
            .provider
            .rpc_client()
            .get_block(*payment_pda_slot)
            .await?;

        self.log_meta_composer
            .log_meta(block, log_index, payment_pda_pubkey, payment_pda_slot)
            .map_err(Into::<ChainCommunicationError>::into)
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for SealevelInterchainGasPaymasterIndexer {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    #[instrument(err, skip(self))]
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        info!(
            ?range,
            "Fetching SealevelInterchainGasPaymasterIndexer InterchainGasPayment logs"
        );

        let payments_capacity = range.end().saturating_sub(*range.start());
        let mut payments = Vec::with_capacity(payments_capacity as usize);
        for nonce in range {
            if let Ok(sealevel_payment) = self.get_payment_with_sequence(nonce.into()).await {
                let igp_account_filter = self.igp.igp_account;
                let mut payment = *sealevel_payment.payment.inner();
                // If fees is paid to a different IGP account, we zero out the payment to make sure the db entries are contiguous, but at the same time, gasEnforcer will reject the message (if not set to none policy)
                if igp_account_filter != sealevel_payment.igp_account_pubkey {
                    tracing::debug!(sealevel_payment=?sealevel_payment, igp_account_filter=?igp_account_filter, "Found interchain gas payment for a different IGP account, neutralizing payment");

                    payment.payment = U256::from(0);
                }
                payments.push((
                    Indexed::new(payment).with_sequence(nonce),
                    sealevel_payment.log_meta,
                ));
            }
        }
        Ok(payments)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        // we should not report block height since SequenceAwareIndexer uses block slot in
        // `latest_sequence_count_and_tip` and we should not report block slot here
        // since block slot cannot be used as watermark
        unimplemented!()
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for SealevelInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let program_data_account = self
            .provider
            .rpc_client()
            .get_account_with_finalized_commitment(self.igp.data_pda_pubkey)
            .await?;
        let program_data = ProgramDataAccount::fetch(&mut program_data_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        let payment_count = program_data
            .payment_count
            .try_into()
            .map_err(StrOrIntParseError::from)?;
        let tip = self.igp.provider.rpc_client().get_slot().await?;
        Ok((Some(payment_count), tip))
    }
}

#[cfg(test)]
mod tests {
    use borsh::BorshSerialize;
    use hyperlane_sealevel_igp::accounts::GasPaymentData;

    use super::*;

    #[test]
    fn test_unique_gas_payment_pubkey_offset() {
        let expected_unique_gas_payment_pubkey = Pubkey::new_unique();

        let gas_payment = GasPaymentAccount::new(
            GasPaymentData {
                sequence_number: 123,
                igp: Default::default(),
                destination_domain: Default::default(),
                message_id: Default::default(),
                gas_amount: Default::default(),
                payment: Default::default(),
                unique_gas_payment_pubkey: expected_unique_gas_payment_pubkey,
                slot: Default::default(),
            }
            .into(),
        );

        let serialized = gas_payment.into_inner().try_to_vec().unwrap();
        // Note: although unclear in the docs, the reason for subtracting 1 is as follows.
        // The `offset` field of `memcmp` does not add to the offset of the `dataSlice` filtering param in `get_payment_with_sequence`.
        // As such, `UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET` has to account for that 1-byte offset of that `offset` field, which represents
        // an `is_initialized` boolean.
        // Since the dummy `GasPaymentAccount` is not prefixed by an `is_initialized` boolean, we have to subtract 1 from the offset.
        let sliced_unique_gas_payment_pubkey = Pubkey::new(
            &serialized[(UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET - 1)
                ..(UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET + 32 - 1)],
        );
        assert_eq!(
            expected_unique_gas_payment_pubkey,
            sliced_unique_gas_payment_pubkey
        );
    }
}
