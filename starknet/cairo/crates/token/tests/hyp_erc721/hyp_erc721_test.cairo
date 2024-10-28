use alexandria_bytes::Bytes;
use contracts::client::router_component::{IRouterDispatcher, IRouterDispatcherTrait};
use starknet::ContractAddress;
use super::common::{
    setup, DESTINATION, INITIAL_SUPPLY, Setup, IHypErc721TestDispatcher,
    IHypErc721TestDispatcherTrait, ALICE, BOB, deploy_remote_token, perform_remote_transfer
};
use token::components::token_router::{ITokenRouterDispatcher, ITokenRouterDispatcherTrait};

fn hyp_erc721_setup() -> Setup {
    let mut setup = setup();

    let remote_token_address: felt252 = setup.remote_token.contract_address.into();
    setup.local_token.enroll_remote_router(DESTINATION, remote_token_address.into());

    setup
}

#[test]
fn test_erc721_total_supply() {
    let setup = hyp_erc721_setup();

    let balance = setup.local_token.balance_of(starknet::get_contract_address());
    assert_eq!(balance, INITIAL_SUPPLY);
}

#[test]
fn test_erc721_owner_of() {
    let setup = hyp_erc721_setup();

    let owner = setup.local_token.owner_of(0);
    assert_eq!(owner, starknet::get_contract_address());
}

#[test]
fn test_erc721_local_transfer() {
    let setup = hyp_erc721_setup();

    let this_address = starknet::get_contract_address();
    setup.local_token.transfer_from(this_address, ALICE(), 0);
    assert_eq!(setup.local_token.balance_of(this_address), INITIAL_SUPPLY - 1);
    assert_eq!(setup.local_token.balance_of(ALICE()), 1);
}

#[test]
#[should_panic]
fn test_erc721_local_transfer_invalid_token_id() {
    let setup = hyp_erc721_setup();

    let this_address = starknet::get_contract_address();
    setup.local_token.transfer_from(this_address, ALICE(), INITIAL_SUPPLY);
}

#[test]
fn test_erc721_remote_transfer(is_collateral: u8) {
    let mut setup = hyp_erc721_setup();

    let is_collateral = if is_collateral % 2 == 0 {
        true
    } else {
        false
    };

    let setup = deploy_remote_token(setup, is_collateral);
    perform_remote_transfer(@setup, 2500, 0);
    assert_eq!(setup.local_token.balance_of(starknet::get_contract_address()), INITIAL_SUPPLY - 1);
}

#[test]
#[should_panic]
fn test_erc721_remote_transfer_revert_unowned() {
    let setup = hyp_erc721_setup();

    setup.local_token.transfer_from(starknet::get_contract_address(), BOB(), 1);

    let setup = deploy_remote_token(setup, false);
    perform_remote_transfer(@setup, 2500, 1);
}

#[test]
#[should_panic]
fn test_erc721_remote_transfer_revert_invalid_token_id() {
    let setup = hyp_erc721_setup();

    let setup = deploy_remote_token(setup, true);
    perform_remote_transfer(@setup, 2500, INITIAL_SUPPLY);
}
