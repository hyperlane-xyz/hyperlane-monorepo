use alexandria_bytes::Bytes;
use contracts::client::router_component::{IRouterDispatcher, IRouterDispatcherTrait};
use mocks::test_erc721::{ITestERC721Dispatcher, ITestERC721DispatcherTrait};
use snforge_std::cheatcodes::contract_class::{ContractClass, ContractClassTrait};
use starknet::ContractAddress;
use super::common::{
    setup, DESTINATION, INITIAL_SUPPLY, Setup, IHypErc721TestDispatcher,
    IHypErc721TestDispatcherTrait, ALICE, BOB, deploy_remote_token, perform_remote_transfer,
    ZERO_ADDRESS
};
use token::components::token_router::{ITokenRouterDispatcher, ITokenRouterDispatcherTrait};

fn setup_erc721_collateral() -> Setup {
    let mut setup = setup();

    let mut calldata: Array<felt252> = array![];
    setup.local_primary_token.contract_address.serialize(ref calldata);
    setup.local_mailbox.contract_address.serialize(ref calldata);
    setup.noop_hook.contract_address.serialize(ref calldata);
    setup.default_ism.serialize(ref calldata);
    starknet::get_contract_address().serialize(ref calldata);

    let (local_token, _) = setup.hyp_erc721_collateral_contract.deploy(@calldata).unwrap();
    let local_token = IHypErc721TestDispatcher { contract_address: local_token };

    setup.local_token = local_token;

    let remote_token_address: felt252 = setup.remote_token.contract_address.into();
    setup.local_token.enroll_remote_router(DESTINATION, remote_token_address.into());

    setup
        .local_primary_token
        .transfer_from(
            starknet::get_contract_address(), setup.local_token.contract_address, INITIAL_SUPPLY + 1
        );

    setup
}

#[test]
fn test_erc721_collateral_remote_transfer() {
    let mut setup = setup_erc721_collateral();

    let setup = deploy_remote_token(setup, false);
    setup.local_primary_token.approve(setup.local_token.contract_address, 0);
    perform_remote_transfer(@setup, 2500, 0);

    assert_eq!(
        setup.local_token.balance_of(starknet::get_contract_address()), INITIAL_SUPPLY * 2 - 2
    );
}

#[test]
#[should_panic]
fn test_erc721_collateral_remote_transfer_revert_unowned() {
    let mut setup = setup_erc721_collateral();

    setup.local_primary_token.transfer_from(starknet::get_contract_address(), setup.bob, 1);

    let setup = deploy_remote_token(setup, false);
    perform_remote_transfer(@setup, 2500, 1);
}

#[test]
#[should_panic]
fn test_erc721_collateral_remote_transfer_revert_invalid_token_id() {
    let mut setup = setup_erc721_collateral();

    let setup = deploy_remote_token(setup, false);
    perform_remote_transfer(@setup, 2500, INITIAL_SUPPLY * 2);
}

