use async_trait::async_trait;
use hyperlane_core::{
    config::StrOrIntParseError, ChainCommunicationError, ChainResult, ContractLocator,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider, Indexer,
    InterchainGasPaymaster, InterchainGasPayment, LogMeta, SequenceIndexer, H256, H512,
};
use hyperlane_sealevel_igp::{
    accounts::{GasPaymentAccount, ProgramDataAccount},
    igp_gas_payment_pda_seeds, igp_program_data_pda_seeds,
};
use solana_account_decoder::{UiAccountEncoding, UiDataSliceConfig};
use solana_client::{
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType},
};
use std::ops::RangeInclusive;
use tracing::{info, instrument};

use crate::{
    client::RpcClientWithDebug, utils::get_finalized_block_number, ConnectionConf, SealevelProvider,
};
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey};

use derive_new::new;

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
}

impl SealevelInterchainGasPaymaster {
    /// Create a new Sealevel IGP.
    pub async fn new(
        conf: &ConnectionConf,
        igp_account_locator: &ContractLocator<'_>,
    ) -> ChainResult<Self> {
        let rpc_client = RpcClientWithDebug::new_with_commitment(
            conf.url.to_string(),
            CommitmentConfig::processed(),
        );
        let program_id =
            Self::determine_igp_program_id(&rpc_client, &igp_account_locator.address).await?;
        let (data_pda_pubkey, _) =
            Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);

        Ok(Self {
            program_id,
            data_pda_pubkey,
            domain: igp_account_locator.domain.clone(),
            igp_account: igp_account_locator.address,
        })
    }

    async fn determine_igp_program_id(
        rpc_client: &RpcClientWithDebug,
        igp_account_pubkey: &H256,
    ) -> ChainResult<Pubkey> {
        let account = rpc_client
            .get_account_with_commitment(
                &Pubkey::from(<[u8; 32]>::from(*igp_account_pubkey)),
                CommitmentConfig::finalized(),
            )
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Could not find IGP account for pubkey")
            })?;
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
        Box::new(SealevelProvider::new(self.domain.clone()))
    }
}

impl InterchainGasPaymaster for SealevelInterchainGasPaymaster {}

/// Struct that retrieves event data for a Sealevel IGP contract
#[derive(Debug)]
pub struct SealevelInterchainGasPaymasterIndexer {
    rpc_client: RpcClientWithDebug,
    igp: SealevelInterchainGasPaymaster,
}

/// IGP payment data on Sealevel
#[derive(Debug, new)]
pub struct SealevelGasPayment {
    payment: InterchainGasPayment,
    log_meta: LogMeta,
    igp_account_pubkey: H256,
}

impl SealevelInterchainGasPaymasterIndexer {
    /// Create a new Sealevel IGP indexer.
    pub async fn new(
        conf: &ConnectionConf,
        igp_account_locator: ContractLocator<'_>,
    ) -> ChainResult<Self> {
        // Set the `processed` commitment at rpc level
        let rpc_client = RpcClientWithDebug::new_with_commitment(
            conf.url.to_string(),
            CommitmentConfig::processed(),
        );

        let igp = SealevelInterchainGasPaymaster::new(conf, &igp_account_locator).await?;
        Ok(Self { rpc_client, igp })
    }

    #[instrument(err, skip(self))]
    async fn get_payment_with_sequence(
        &self,
        sequence_number: u64,
    ) -> ChainResult<SealevelGasPayment> {
        let payment_bytes = &[
            &hyperlane_sealevel_igp::accounts::GAS_PAYMENT_DISCRIMINATOR[..],
            &sequence_number.to_le_bytes()[..],
        ]
        .concat();
        #[allow(deprecated)]
        let payment_bytes: String = base64::encode(payment_bytes);

        // First, find all accounts with the matching gas payment data.
        // To keep responses small in case there is ever more than 1
        // match, we don't request the full account data, and just request
        // the `unique_gas_payment_pubkey` field.
        #[allow(deprecated)]
        let memcmp = RpcFilterType::Memcmp(Memcmp {
            // Ignore the first byte, which is the `initialized` bool flag.
            offset: 1,
            bytes: MemcmpEncodedBytes::Base64(payment_bytes),
            encoding: None,
        });
        let config = RpcProgramAccountsConfig {
            filters: Some(vec![memcmp]),
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                // Don't return any data
                data_slice: Some(UiDataSliceConfig {
                    offset: UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET,
                    length: 32, // the length of the `unique_gas_payment_pubkey` field
                }),
                commitment: Some(CommitmentConfig::finalized()),
                min_context_slot: None,
            },
            with_context: Some(false),
        };
        tracing::debug!(config=?config, "Fetching program accounts");
        let accounts = self
            .rpc_client
            .get_program_accounts_with_config(&self.igp.program_id, config)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        tracing::debug!(accounts=?accounts, "Fetched program accounts");

        // Now loop through matching accounts and find the one with a valid account pubkey
        // that proves it's an actual gas payment PDA.
        let mut valid_payment_pda_pubkey = Option::<Pubkey>::None;

        for (pubkey, account) in accounts {
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
            if expected_pubkey == pubkey {
                valid_payment_pda_pubkey = Some(pubkey);
                break;
            }
        }

        let valid_payment_pda_pubkey = valid_payment_pda_pubkey.ok_or_else(|| {
            ChainCommunicationError::from_other_str("Could not find valid gas payment PDA pubkey")
        })?;

        // Now that we have the valid gas payment PDA pubkey, we can get the full account data.
        let account = self
            .rpc_client
            .get_account_with_commitment(&valid_payment_pda_pubkey, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Could not find account data")
            })?;
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

        Ok(SealevelGasPayment::new(
            igp_payment,
            LogMeta {
                address: self.igp.program_id.to_bytes().into(),
                block_number: gas_payment_account.slot,
                // TODO: get these when building out scraper support.
                // It's inconvenient to get these :|
                block_hash: H256::zero(),
                transaction_id: H512::zero(),
                transaction_index: 0,
                log_index: sequence_number.into(),
            },
            H256::from(gas_payment_account.igp.to_bytes()),
        ))
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for SealevelInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        info!(
            ?range,
            "Fetching SealevelInterchainGasPaymasterIndexer InterchainGasPayment logs"
        );

        let payments_capacity = range.end().saturating_sub(*range.start());
        let mut payments = Vec::with_capacity(payments_capacity as usize);
        for nonce in range {
            if let Ok(sealevel_payment) = self.get_payment_with_sequence(nonce.into()).await {
                let igp_account_filter = self.igp.igp_account;
                if igp_account_filter == sealevel_payment.igp_account_pubkey {
                    payments.push((sealevel_payment.payment, sealevel_payment.log_meta));
                } else {
                    tracing::debug!(sealevel_payment=?sealevel_payment, igp_account_filter=?igp_account_filter, "Found interchain gas payment for a different IGP account, skipping");
                }
            }
        }
        Ok(payments)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_finalized_block_number(&self.rpc_client).await
    }
}

#[async_trait]
impl SequenceIndexer<InterchainGasPayment> for SealevelInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let program_data_account = self
            .rpc_client
            .get_account_with_commitment(&self.igp.data_pda_pubkey, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Could not find account data")
            })?;
        let program_data = ProgramDataAccount::fetch(&mut program_data_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        let payment_count = program_data
            .payment_count
            .try_into()
            .map_err(StrOrIntParseError::from)?;
        let tip = get_finalized_block_number(&self.rpc_client).await?;
        Ok((Some(payment_count), tip))
    }
}

#[test]
fn test_unique_gas_payment_pubkey_offset() {
    use borsh::BorshSerialize;
    use hyperlane_sealevel_igp::accounts::GasPaymentData;
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
        &serialized
            [(UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET - 1)..(UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET + 32 - 1)],
    );
    assert_eq!(
        expected_unique_gas_payment_pubkey,
        sliced_unique_gas_payment_pubkey
    );
}
