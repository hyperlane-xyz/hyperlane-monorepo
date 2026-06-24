use std::collections::HashMap;

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_token_lib::hyperlane_token_pda_seeds;
use solana_client::rpc_client::RpcClient;
use solana_program::pubkey::Pubkey;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct HyperlaneTokenCoreData {
    pub bump: u8,
    pub mailbox: Pubkey,
    pub mailbox_process_authority: Pubkey,
    pub dispatch_authority_bump: u8,
    pub decimals: u8,
    pub remote_decimals: u8,
    pub owner: Option<Pubkey>,
    pub interchain_security_module: Option<Pubkey>,
    pub interchain_gas_paymaster: Option<(Pubkey, InterchainGasPaymasterType)>,
    pub destination_gas: HashMap<u32, u64>,
    pub remote_routers: HashMap<u32, H256>,
}

pub fn fetch_token_core_data(client: &RpcClient, program_id: &Pubkey) -> HyperlaneTokenCoreData {
    let (token_pda, _token_bump) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);
    let account = client.get_account(&token_pda).unwrap();
    parse_token_core_data(&account.data)
}

pub fn parse_token_core_data(account_data: &[u8]) -> HyperlaneTokenCoreData {
    let mut data = account_data;
    let initialized = bool::deserialize(&mut data).unwrap();
    assert!(initialized, "Hyperlane token account is not initialized");
    HyperlaneTokenCoreData::deserialize(&mut data).unwrap()
}
