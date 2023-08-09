#![allow(warnings)] // FIXME remove

use async_trait::async_trait;
use hyperlane_core::{
    config::StrOrIntParseError, ChainCommunicationError, ChainResult, ContractLocator,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider, Indexer,
    InterchainGasPaymaster, InterchainGasPayment, LogMeta, SequenceIndexer, H256, H512, U256,
};
use hyperlane_sealevel_igp::{
    accounts::{GasPaymentAccount, GasPaymentData, ProgramDataAccount},
    igp_gas_payment_pda_seeds, igp_pda_seeds, igp_program_data_pda_seeds,
};
use solana_account_decoder::{UiAccountEncoding, UiDataSliceConfig};
use solana_client::{
    nonblocking::rpc_client::RpcClient,
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType},
};
use std::ops::RangeInclusive;
use tracing::{debug, info, instrument};

use crate::{
    client::RpcClientWithDebug, utils::get_finalized_block_number, ConnectionConf, SealevelConf,
    SealevelProvider,
};
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey};

use derive_new::new;

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {
    program_id: Pubkey,
    data_pda: (Pubkey, u8),
    domain: HyperlaneDomain,
}

impl SealevelInterchainGasPaymaster {
    /// Create a new Sealevel IGP.
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> Self {
        // Set the `processed` commitment at rpc level
        let rpc_client =
            RpcClient::new_with_commitment(conf.url.to_string(), CommitmentConfig::processed());

        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        let domain = locator.domain.id();
        let data_pda = Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);

        debug!(
            domain,
            %program_id,
            data_pda_pubkey = %data_pda.0,
            data_pda_seed = data_pda.1,
            "Found sealevel IGP program data PDA"
        );

        Self {
            program_id,
            data_pda,
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
    program_id: Pubkey,
    sealevel_config: Option<SealevelConf>,
}

#[derive(Debug, new)]
pub struct SealevelGasPayment {
    payment: InterchainGasPayment,
    log_meta: LogMeta,
    beneficiary: H256,
}

impl SealevelInterchainGasPaymasterIndexer {
    /// Create a new Sealevel IGP indexer.
    pub fn new(
        conf: &ConnectionConf,
        locator: ContractLocator,
        sealevel_config: Option<SealevelConf>,
    ) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        // Set the `processed` commitment at rpc level
        let rpc_client = RpcClientWithDebug::new_with_commitment(
            conf.url.to_string(),
            CommitmentConfig::processed(),
        );
        let igp = SealevelInterchainGasPaymaster::new(conf, locator);
        Self {
            program_id,
            rpc_client,
            igp,
            sealevel_config,
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
        let payment_bytes: String = base64::encode(payment_bytes);

        // First, find all accounts with the matching gas payment data.
        // To keep responses small in case there is ever more than 1
        // match, we don't request the full account data, and just request
        // the `unique_gas_payment_pubkey` field.
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
                    offset: 1 + 8 + 8 + 32 + 4 + 32 + 8 + 8, // the offset to get the `unique_gas_payment_pubkey` field
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
        let dispatched_payment_account = GasPaymentAccount::fetch(&mut account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        let igp_payment = InterchainGasPayment {
            message_id: dispatched_payment_account.message_id,
            payment: dispatched_payment_account.payment.into(),
            gas_amount: dispatched_payment_account.gas_amount.into(),
        };

        Ok(SealevelGasPayment::new(
            igp_payment,
            LogMeta {
                address: self.igp.program_id.to_bytes().into(),
                block_number: dispatched_payment_account.slot,
                // TODO: get these when building out scraper support.
                // It's inconvenient to get these :|
                block_hash: H256::zero(),
                transaction_id: H512::zero(),
                transaction_index: 0,
                log_index: U256::zero(),
            },
            H256::from(dispatched_payment_account.igp.to_bytes()),
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
                let sealevel_config = self.sealevel_config.clone().unwrap_or_default();
                let beneficiary_filter = sealevel_config
                    .relayer_account
                    .unwrap_or(sealevel_payment.beneficiary.clone());
                if beneficiary_filter == sealevel_payment.beneficiary {
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
            .get_account_with_commitment(&self.igp.data_pda.0, CommitmentConfig::finalized())
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
