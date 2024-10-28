use alexandria_bytes::Bytes;
use contracts::client::router_component::{IRouterDispatcher, IRouterDispatcherTrait};
use mocks::test_erc721::{ITestERC721Dispatcher, ITestERC721DispatcherTrait};
use snforge_std::cheatcodes::contract_class::{ContractClass, ContractClassTrait};
use snforge_std::{
    declare, CheatTarget, EventSpy, EventAssertions, spy_events, SpyOn, start_prank, stop_prank,
    EventFetcher, event_name_hash
};
use starknet::ContractAddress;
use super::common::{
    setup, DESTINATION, INITIAL_SUPPLY, Setup, IHypErc721TestDispatcher,
    IHypErc721TestDispatcherTrait, ALICE, BOB, deploy_remote_token, perform_remote_transfer,
    ZERO_ADDRESS, NAME, SYMBOL, URI
};
use token::components::token_router::{ITokenRouterDispatcher, ITokenRouterDispatcherTrait};

fn setup_erc721_uri_storage() -> Setup {
    let mut setup = setup();

    let contract = declare("MockHypERC721URIStorage").unwrap();
    let mut calldata: Array<felt252> = array![];
    setup.local_mailbox.contract_address.serialize(ref calldata);
    INITIAL_SUPPLY.serialize(ref calldata);
    NAME().serialize(ref calldata);
    SYMBOL().serialize(ref calldata);
    setup.noop_hook.contract_address.serialize(ref calldata);
    setup.default_ism.serialize(ref calldata);
    starknet::get_contract_address().serialize(ref calldata);
    let (hyp_erc721_uri_storage, _) = contract.deploy(@calldata).unwrap();
    let hyp_erc721_uri_storage = IHypErc721TestDispatcher {
        contract_address: hyp_erc721_uri_storage
    };

    hyp_erc721_uri_storage.set_token_uri(0, URI());
    let remote_token_address: felt252 = setup.remote_token.contract_address.into();
    hyp_erc721_uri_storage.enroll_remote_router(DESTINATION, remote_token_address.into());

    setup.local_token = hyp_erc721_uri_storage;

    setup
}

#[test]
#[should_panic]
fn test_erc721_uri_storage_remote_transfer_revert_burned() {
    let setup = setup_erc721_uri_storage();

    let setup = deploy_remote_token(setup, false);
    perform_remote_transfer(@setup, 2500, 0);

    let balance = setup.local_token.balance_of(starknet::get_contract_address());
    assert_eq!(balance, INITIAL_SUPPLY - 1);

    let uri = setup.local_token.token_uri(0);
    assert_eq!(uri, URI());
}

