#![allow(warnings)] // FIXME remove

use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, Indexer, InterchainGasPaymaster, InterchainGasPayment,
    LogMeta, SequenceIndexer, H256, U256,
};
use hyperlane_sealevel_igp::{
    accounts::{GasPaymentAccount, GasPaymentData, ProgramDataAccount},
    igp_pda_seeds, igp_program_data_pda_seeds,
};
use solana_account_decoder::{UiAccountEncoding, UiDataSliceConfig};
use solana_client::{
    nonblocking::rpc_client::RpcClient,
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType},
};
use std::ops::RangeInclusive;
use tracing::{debug, info, instrument};

use crate::{client::RpcClientWithDebug, ConnectionConf, SealevelProvider};
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey};

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {
    program_id: Pubkey,
    // pda: (Pubkey, u8),
    data_pda: (Pubkey, u8),
    domain: HyperlaneDomain,
}

impl SealevelInterchainGasPaymaster {
    /// Create a new Sealevel IGP.
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> Self {
        // pub fn new(conf: &ConnectionConf, locator: ContractLocator, seed: u64) -> Self {
        // Set the `processed` commitment at rpc level
        let rpc_client =
            RpcClient::new_with_commitment(conf.url.to_string(), CommitmentConfig::processed());

        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        let domain = locator.domain.id();
        // TODO: is this the right way of passing the seed?
        // let pda = Pubkey::find_program_address(igp_pda_seeds!(seed), &program_id);
        let data_pda = Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);

        debug!(
            "domain={}\nmailbox={}\ndata_pda=({}, {})",
            domain, program_id, data_pda.0, data_pda.1,
        );

        Self {
            program_id,
            // pda,
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
        let igp = SealevelInterchainGasPaymaster::new(conf, locator);
        Self {
            program_id,
            rpc_client,
            igp,
        }
    }

    async fn get_payment_with_sequence(
        &self,
        sequence_number: u64,
    ) -> ChainResult<(InterchainGasPayment, LogMeta)> {
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
                    offset: 1 + 8 + 32 + 4 + 32 + 8, // the offset to get the `unique_gas_payment_pubkey` field
                    length: 32, // the length of the `unique_gas_payment_pubkey` field
                }),
                commitment: Some(CommitmentConfig::finalized()),
                min_context_slot: None,
            },
            with_context: Some(false),
        };
        // print program id
        println!("igp program_id={}", self.igp.program_id);
        let accounts = self
            .rpc_client
            .get_program_accounts_with_config(&self.igp.program_id, config)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        println!("accounts={:#?}", accounts);

        // Now loop through matching accounts and find the one with a valid account pubkey
        // that proves it's an actual message storage PDA.
        let mut valid_payment_pda_pubkey = Option::<Pubkey>::None;

        for (pubkey, account) in accounts.iter() {
            let unique_message_pubkey = Pubkey::new(&account.data);
            let (expected_pubkey, _bump) = Pubkey::try_find_program_address(
                // TODO: should the bump be passed as a seed?
                igp_program_data_pda_seeds!(),
                &self.igp.program_id,
            )
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str(
                    "Could not find program address for unique_gas_payment_pubkey",
                )
            })?;
            info!(
                "~~~~~~~ unique_message_pubkey={}\nexpected_pubkey={} \n program_id={}",
                unique_message_pubkey, expected_pubkey, self.igp.program_id
            );
            if expected_pubkey == *pubkey {
                valid_payment_pda_pubkey = Some(*pubkey);
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
            payment: Default::default(),
            gas_amount: dispatched_payment_account.gas_amount.into(),
        };

        print!("~~~~~~~~ Found IGP payment: {:?}", igp_payment);

        Ok((
            igp_payment,
            LogMeta {
                address: self.igp.program_id.to_bytes().into(),
                block_number: dispatched_payment_account.slot,
                // TODO: get these when building out scraper support.
                // It's inconvenient to get these :|
                block_hash: H256::zero(),
                transaction_hash: H256::zero(),
                transaction_index: 0,
                log_index: U256::zero(),
            },
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

        println!("~~~~~~~~~~~ Indexing IGP payments in range: {:?}", range);
        let mut messages = Vec::with_capacity((range.end() - range.start()) as usize);
        for nonce in range {
            if let Ok(msg) = self.get_payment_with_sequence(nonce.into()).await {
                messages.push(msg);
            }
        }
        Ok(messages)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        // As a workaround to avoid gas payment indexing on Sealevel,
        // we pretend the block number is 1.
        Ok(1)
    }
}

#[async_trait]
impl SequenceIndexer<InterchainGasPayment> for SealevelInterchainGasPaymasterIndexer {
    async fn sequence_at_tip(&self) -> ChainResult<(u32, u32)> {
        info!("Gas payment indexing not implemented for Sealevel");
        Ok((1, 1))
    }
}
