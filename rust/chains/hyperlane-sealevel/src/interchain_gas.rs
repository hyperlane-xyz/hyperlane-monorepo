use async_trait::async_trait;
use base64::{engine::general_purpose, Engine};
use hyperlane_core::{
    config::StrOrIntParseError, ChainCommunicationError, ChainResult, ContractLocator,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider, Indexer,
    InterchainGasPaymaster, InterchainGasPayment, LogMeta, SequenceIndexer, H256, H512, U256,
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
use std::sync::OnceLock;
use tracing::{debug, info, instrument};

use crate::{
    client::RpcClientWithDebug, utils::get_finalized_block_number, ConnectionConf, SealevelProvider,
};
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey};

use derive_new::new;

/// The offset to get the `unique_gas_payment_pubkey` field from the serialized GasPaymentData
const UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET: usize = 1 + 8 + 8 + 32 + 4 + 32 + 8 + 8;

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {
    program_id: Pubkey,
    data_pda_pubkey: Pubkey,
    domain: HyperlaneDomain,
}

impl SealevelInterchainGasPaymaster {
    /// Create a new Sealevel IGP.
    pub fn new(locator: ContractLocator) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        let domain = locator.domain.id();
        let (data_pda_pubkey, _) =
            Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);

        debug!(
            domain,
            %program_id,
            %data_pda_pubkey,
            "Found sealevel IGP program data PDA"
        );

        Self {
            program_id,
            data_pda_pubkey,
            domain: locator.domain.clone(),
        }
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
    _program_id: Pubkey,
    igp_account: OnceLock<H256>,
}

impl SealevelInterchainGasPaymasterIndexer {
    async fn get_igp_account(&self, igp_account_pubkey: &H256) -> ChainResult<H256> {
        if let Some(igp) = self.igp_account.get() {
            return Ok(*igp);
        }
        let account = self
            .rpc_client
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
        let account_owner_pubkey = account.owner.to_bytes().into();
        self.igp_account.set(account_owner_pubkey).map_err(|_| {
            ChainCommunicationError::from_other_str("IGP account singleton set more than once")
        })?;
        Ok(account_owner_pubkey)
    }
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
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        // Set the `processed` commitment at rpc level
        let rpc_client = RpcClientWithDebug::new_with_commitment(
            conf.url.to_string(),
            CommitmentConfig::processed(),
        );
        let igp = SealevelInterchainGasPaymaster::new(locator);
        Self {
            _program_id: program_id,
            rpc_client,
            igp,
            igp_account: OnceLock::new(),
        }
    }

    async fn get_payment_with_sequence(
        &self,
        sequence_number: u64,
    ) -> ChainResult<SealevelGasPayment> {
        let payment_bytes = &[
            &hyperlane_sealevel_igp::accounts::GAS_PAYMENT_DISCRIMINATOR[..],
            &sequence_number.to_le_bytes()[..],
        ]
        .concat();
        let payment_bytes: String = general_purpose::STANDARD.encode(payment_bytes);

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
                    // TODO: Do not use magic constants and use encoding sizes instead
                    offset: UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET,
                    length: 32, // the length of the `unique_gas_payment_pubkey` field
                }),
                commitment: Some(CommitmentConfig::finalized()),
                min_context_slot: None,
            },
            with_context: Some(false),
        };
        let accounts = self
            .rpc_client
            .get_program_accounts_with_config(&self.igp.program_id, config)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        // Now loop through matching accounts and find the one with a valid account pubkey
        // that proves it's an actual message storage PDA.
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
            ChainCommunicationError::from_other_str(
                "Could not find valid message storage PDA pubkey",
            )
        })?;

        // Now that we have the valid message storage PDA pubkey, we can get the full account data.
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

        let igp_payment = InterchainGasPayment {
            message_id: gas_payment_account.message_id,
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
                log_index: U256::zero(),
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

        let mut payments = Vec::with_capacity((range.end() - range.start()) as usize);
        for nonce in range {
            if let Ok(sealevel_payment) = self.get_payment_with_sequence(nonce.into()).await {
                let igp_account_filter = self
                    .get_igp_account(&sealevel_payment.igp_account_pubkey)
                    .await?;
                if igp_account_filter == sealevel_payment.igp_account_pubkey {
                    payments.push((sealevel_payment.payment, sealevel_payment.log_meta));
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
    async fn sequence_at_tip(&self) -> ChainResult<Option<(u32, u32)>> {
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
            .map_err(|err| StrOrIntParseError::from(err))?;
        let tip = get_finalized_block_number(&self.rpc_client).await?;
        Ok(Some((payment_count, tip)))
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
    let sliced_unique_gas_payment_pubkey = Pubkey::new(
        &serialized
            [(UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET - 1)..(UNIQUE_GAS_PAYMENT_PUBKEY_OFFSET + 32 - 1)],
    );
    assert_eq!(
        expected_unique_gas_payment_pubkey,
        sliced_unique_gas_payment_pubkey
    );
}
