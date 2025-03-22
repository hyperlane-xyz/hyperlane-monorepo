use base64::{engine::general_purpose::STANDARD as Base64, Engine};
use solana_account_decoder::{UiAccountEncoding, UiDataSliceConfig};
use solana_client::{
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType},
};
use solana_sdk::{account::Account, commitment_config::CommitmentConfig, pubkey::Pubkey};

use hyperlane_core::{ChainCommunicationError, ChainResult};

use crate::SealevelProvider;

pub async fn search_accounts_by_discriminator(
    provider: &SealevelProvider,
    program_id: &Pubkey,
    discriminator: &[u8; 8],
    nonce_bytes: &[u8],
    offset: usize,
    length: usize,
) -> ChainResult<Vec<(Pubkey, Account)>> {
    let target_message_account_bytes = &[discriminator, nonce_bytes].concat();
    let target_message_account_bytes = Base64.encode(target_message_account_bytes);

    // First, find all accounts with the matching account data.
    // To keep responses small in case there is ever more than 1
    // match, we don't request the full account data, and just request
    // the field which was used to generate account id
    #[allow(deprecated)]
    let memcmp = RpcFilterType::Memcmp(Memcmp {
        // Ignore the first byte, which is the `initialized` bool flag.
        offset: 1,
        bytes: MemcmpEncodedBytes::Base64(target_message_account_bytes),
        encoding: None,
    });
    let config = RpcProgramAccountsConfig {
        filters: Some(vec![memcmp]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: Some(UiDataSliceConfig { offset, length }),
            commitment: Some(CommitmentConfig::finalized()),
            min_context_slot: None,
        },
        with_context: Some(false),
    };
    let accounts = provider
        .rpc_client()
        .get_program_accounts_with_config(*program_id, config)
        .await?;
    Ok(accounts)
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
