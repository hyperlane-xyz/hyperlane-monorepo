use base64::{engine::general_purpose::STANDARD as Base64, Engine};
use solana_account_decoder::{UiAccountEncoding, UiDataSliceConfig};
use solana_client::{
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType},
};
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{account::Account, pubkey::Pubkey};

use hyperlane_core::{ChainCommunicationError, ChainResult, H256};
use hyperlane_sealevel_igp::accounts::GAS_PAYMENT_DISCRIMINATOR;
use hyperlane_sealevel_mailbox::accounts::{
    DISPATCHED_MESSAGE_DISCRIMINATOR, PROCESSED_MESSAGE_DISCRIMINATOR,
};

use crate::SealevelProvider;

pub async fn search_accounts_by_discriminator(
    provider: &SealevelProvider,
    program_id: &Pubkey,
    discriminator: &[u8; 8],
    nonce_bytes: &[u8],
    offset: usize,
    length: usize,
) -> ChainResult<Vec<(Pubkey, Account)>> {
    let config = account_filter(&[discriminator, nonce_bytes].concat(), offset, length);
    let accounts = provider
        .rpc_client()
        .get_program_accounts_with_config(*program_id, config)
        .await?;
    Ok(accounts)
}

/// Finalized program-account filters for scraper wake-ups. Each dispatch also
/// produces the Sealevel Merkle insertion. Only the notification slot is needed.
pub fn finalized_event_filters(
    mailbox: H256,
    igp_program: H256,
) -> [(Pubkey, RpcProgramAccountsConfig); 3] {
    [
        (mailbox, DISPATCHED_MESSAGE_DISCRIMINATOR),
        (mailbox, PROCESSED_MESSAGE_DISCRIMINATOR),
        (igp_program, GAS_PAYMENT_DISCRIMINATOR),
    ]
    .map(|(program, discriminator)| {
        let mut config = account_filter(discriminator, 0, 0);
        config.with_context = Some(true);
        (Pubkey::from(program.0), config)
    })
}

fn account_filter(prefix: &[u8], offset: usize, length: usize) -> RpcProgramAccountsConfig {
    // The initialized flag precedes the discriminator in AccountData.
    let memcmp = RpcFilterType::Memcmp(Memcmp::new(
        1,
        MemcmpEncodedBytes::Base64(Base64.encode(prefix)),
    ));
    RpcProgramAccountsConfig {
        filters: Some(vec![memcmp]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: Some(UiDataSliceConfig { offset, length }),
            commitment: Some(CommitmentConfig::finalized()),
            min_context_slot: None,
        },
        with_context: Some(false),
        sort_results: None,
    }
}

pub fn search_and_validate_account<F>(
    accounts: Vec<(Pubkey, Account)>,
    message_account: F,
) -> ChainResult<Pubkey>
where
    F: Fn(&Account) -> ChainResult<Pubkey>,
{
    for (pubkey, account) in accounts {
        let expected_pubkey = message_account(&account)?;
        if expected_pubkey == pubkey {
            return Ok(pubkey);
        }
    }

    Err(ChainCommunicationError::from_other_str(
        "Could not find valid storage PDA pubkey",
    ))
}
