use std::{
    future::Future,
    ops::RangeInclusive,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use derive_new::new;
use hyperlane_sealevel_igp::{
    accounts::{GasPaymentAccount, ProgramDataAccount},
    igp_gas_payment_pda_seeds, igp_program_data_pda_seeds,
};
use solana_sdk::{account::Account, clock::Slot, pubkey::Pubkey};
use tracing::{debug, info, instrument};

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

#[derive(Debug, Default)]
struct RangeScanResume {
    range: Option<RangeInclusive<u32>>,
    next_sequence: Option<u32>,
}

impl RangeScanResume {
    fn ranges_overlap(left: &RangeInclusive<u32>, right: &RangeInclusive<u32>) -> bool {
        left.start() <= right.end() && right.start() <= left.end()
    }

    fn next_sequence_for(&self, range: &RangeInclusive<u32>) -> Option<u32> {
        self.range
            .as_ref()
            .filter(|previous| Self::ranges_overlap(previous, range))
            .and(self.next_sequence)
    }

    fn record(&mut self, range: RangeInclusive<u32>, next_sequence: Option<u32>) {
        if let Some(next_sequence) = next_sequence {
            self.range = Some(range);
            self.next_sequence = Some(next_sequence);
        } else if self
            .range
            .as_ref()
            .is_some_and(|previous| Self::ranges_overlap(previous, &range))
        {
            *self = Self::default();
        }
    }
}

// Bound each attempt at the first failed RPC, then rotate the next attempt so a
// permanently unavailable sequence does not hide later payments. The sequence
// cursor still requires exact range coverage before it advances.
async fn scan_range_until_error<T, F, Fut>(
    range: RangeInclusive<u32>,
    resume_at: Option<u32>,
    mut fetch: F,
) -> (Vec<(u32, T)>, Option<u32>)
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = ChainResult<T>>,
{
    let range_start = *range.start();
    let range_end = *range.end();
    let scan_start = resume_at
        .filter(|sequence| range.contains(sequence))
        .unwrap_or(range_start);
    let mut values =
        Vec::with_capacity(range_end.saturating_sub(range_start).saturating_add(1) as usize);

    for sequence in (scan_start..=range_end).chain(range_start..scan_start) {
        match fetch(sequence).await {
            Ok(value) => values.push((sequence, value)),
            Err(_) => {
                let next_sequence = if sequence == range_end {
                    range_start
                } else {
                    sequence.saturating_add(1)
                };
                values.sort_unstable_by_key(|(sequence, _)| *sequence);
                return (values, Some(next_sequence));
            }
        }
    }

    values.sort_unstable_by_key(|(sequence, _)| *sequence);
    (values, None)
}

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
    range_scan_resume: Mutex<RangeScanResume>,
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
            range_scan_resume: Mutex::new(RangeScanResume::default()),
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

        tracing::debug!(
            gas_payment_account=?gas_payment_account,
            payment_pda_pubkey=?valid_payment_pda_pubkey,
            "Found gas payment account",
        );

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
        let unique_gas_payment_pubkey = Pubkey::try_from(account.data.as_slice()).map_err(|e| {
            ChainCommunicationError::from_other_str(&format!("Invalid pubkey: {e}"))
        })?;
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
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        info!(
            ?range,
            "Fetching SealevelInterchainGasPaymasterIndexer InterchainGasPayment logs"
        );

        let resume_at = self
            .range_scan_resume
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .next_sequence_for(&range);
        let (sealevel_payments, next_sequence) =
            scan_range_until_error(range.clone(), resume_at, |nonce| {
                self.get_payment_with_sequence(nonce.into())
            })
            .await;
        self.range_scan_resume
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(range.clone(), next_sequence);
        if let Some(next_sequence) = next_sequence {
            debug!(
                ?range,
                next_sequence, "Stopped IGP range scan after first sequence error"
            );
        }

        let payments = sealevel_payments
            .into_iter()
            .map(|(nonce, sealevel_payment)| {
                let igp_account_filter = self.igp.igp_account;
                let mut payment = *sealevel_payment.payment.inner();
                // If fees is paid to a different IGP account, we zero out the payment to make sure the db entries are contiguous, but at the same time, gasEnforcer will reject the message (if not set to none policy)
                if igp_account_filter != sealevel_payment.igp_account_pubkey {
                    tracing::debug!(sealevel_payment=?sealevel_payment, igp_account_filter=?igp_account_filter, "Found interchain gas payment for a different IGP account, neutralizing payment");

                    payment.payment = U256::from(0);
                }
                (
                    Indexed::new(payment).with_sequence(nonce),
                    sealevel_payment.log_meta,
                )
            })
            .collect();
        Ok(payments)
    }

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

        let serialized = borsh::to_vec(&*gas_payment.into_inner()).unwrap();
        // Note: although unclear in the docs, the reason for subtracting 1 is as follows.
        // The `offset` field of `memcmp` does not add to the offset of the `dataSlice` filtering param in `get_payment_with_sequence`.
        // As such, `UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET` has to account for that 1-byte offset of that `offset` field, which represents
        // an `is_initialized` boolean.
        // Since the dummy `GasPaymentAccount` is not prefixed by an `is_initialized` boolean, we have to subtract 1 from the offset.
        let sliced_unique_gas_payment_pubkey = Pubkey::try_from(
            &serialized[(UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET - 1)
                ..(UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET + 32 - 1)],
        )
        .unwrap();
        assert_eq!(
            expected_unique_gas_payment_pubkey,
            sliced_unique_gas_payment_pubkey
        );
    }

    #[tokio::test]
    async fn range_scan_stops_at_first_error_and_resumes_after_it() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let first_calls = calls.clone();
        let (values, resume_at) = scan_range_until_error(10..=12, None, move |sequence| {
            let calls = first_calls.clone();
            async move {
                calls.lock().expect("calls mutex poisoned").push(sequence);
                if sequence == 10 {
                    Err(ChainCommunicationError::from_other_str("unavailable"))
                } else {
                    Ok(sequence)
                }
            }
        })
        .await;

        assert!(values.is_empty());
        assert_eq!(resume_at, Some(11));
        assert_eq!(*calls.lock().expect("calls mutex poisoned"), vec![10]);

        calls.lock().expect("calls mutex poisoned").clear();
        let second_calls = calls.clone();
        let (values, resume_at) = scan_range_until_error(10..=12, resume_at, move |sequence| {
            let calls = second_calls.clone();
            async move {
                calls.lock().expect("calls mutex poisoned").push(sequence);
                Ok(sequence)
            }
        })
        .await;

        assert_eq!(
            values
                .into_iter()
                .map(|(sequence, _)| sequence)
                .collect::<Vec<_>>(),
            vec![10, 11, 12]
        );
        assert_eq!(resume_at, None);
        assert_eq!(
            *calls.lock().expect("calls mutex poisoned"),
            vec![11, 12, 10]
        );
    }

    #[tokio::test]
    async fn partial_prefix_is_returned_before_rotating_past_the_failure() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let first_calls = calls.clone();
        let (values, resume_at) = scan_range_until_error(10..=13, None, move |sequence| {
            let calls = first_calls.clone();
            async move {
                calls.lock().expect("calls mutex poisoned").push(sequence);
                if sequence == 11 {
                    Err(ChainCommunicationError::from_other_str("unavailable"))
                } else {
                    Ok(sequence)
                }
            }
        })
        .await;

        assert_eq!(values, vec![(10, 10)]);
        assert_eq!(resume_at, Some(12));
        assert_eq!(*calls.lock().expect("calls mutex poisoned"), vec![10, 11]);

        calls.lock().expect("calls mutex poisoned").clear();
        let second_calls = calls.clone();
        let (values, resume_at) = scan_range_until_error(10..=13, resume_at, move |sequence| {
            let calls = second_calls.clone();
            async move {
                calls.lock().expect("calls mutex poisoned").push(sequence);
                Ok(sequence)
            }
        })
        .await;

        assert_eq!(values, vec![(10, 10), (11, 11), (12, 12), (13, 13)]);
        assert_eq!(resume_at, None);
        assert_eq!(
            *calls.lock().expect("calls mutex poisoned"),
            vec![12, 13, 10, 11]
        );
    }

    #[tokio::test]
    async fn persistent_failures_rotate_across_the_full_range() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut resume_at = None;

        for expected in [20, 21, 22, 20] {
            let attempt_calls = calls.clone();
            let (values, next) = scan_range_until_error(20..=22, resume_at, move |sequence| {
                let calls = attempt_calls.clone();
                async move {
                    calls.lock().expect("calls mutex poisoned").push(sequence);
                    Err::<u32, _>(ChainCommunicationError::from_other_str("unavailable"))
                }
            })
            .await;
            assert!(values.is_empty());
            assert_eq!(
                calls.lock().expect("calls mutex poisoned").last(),
                Some(&expected)
            );
            resume_at = next;
        }

        assert_eq!(
            *calls.lock().expect("calls mutex poisoned"),
            vec![20, 21, 22, 20]
        );
    }

    #[test]
    fn unrelated_range_success_does_not_clear_resume_state() {
        let mut state = RangeScanResume::default();
        state.record(20..=22, Some(21));

        state.record(100..=102, None);

        assert_eq!(state.next_sequence_for(&(20..=22)), Some(21));
        assert_eq!(state.next_sequence_for(&(100..=102)), None);

        state.record(21..=23, None);
        assert_eq!(state.next_sequence_for(&(20..=22)), None);
    }
}
