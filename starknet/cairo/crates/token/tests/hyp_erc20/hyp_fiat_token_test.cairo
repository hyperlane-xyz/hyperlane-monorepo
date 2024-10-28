use mocks::test_erc20::{ITestERC20Dispatcher, ITestERC20DispatcherTrait};
use mocks::test_interchain_gas_payment::ITestInterchainGasPaymentDispatcherTrait;
use snforge_std::{
    declare, ContractClassTrait, CheatTarget, EventSpy, EventAssertions, spy_events, SpyOn,
    start_prank, stop_prank, EventFetcher, event_name_hash
};
use starknet::ContractAddress;
use super::common::{
    setup, TOTAL_SUPPLY, DECIMALS, ORIGIN, TRANSFER_AMT, DESTINATION, OWNER,
    perform_remote_transfer_with_emit, perform_remote_transfer_and_gas, ALICE, BOB, E18,
    IHypERC20TestDispatcher, IHypERC20TestDispatcherTrait, enroll_remote_router,
    enroll_local_router, perform_remote_transfer, set_custom_gas_config, REQUIRED_VALUE, GAS_LIMIT,
    Setup, handle_local_transfer
};

fn fiat_token_setup() -> Setup {
    let mut setup = setup();

    let local_token = declare("HypFiatToken").unwrap();

    let mut calldata: Array<felt252> = array![];
    setup.primary_token.contract_address.serialize(ref calldata);
    setup.local_mailbox.contract_address.serialize(ref calldata);
    setup.noop_hook.contract_address.serialize(ref calldata);
    setup.igp.contract_address.serialize(ref calldata);
    starknet::get_contract_address().serialize(ref calldata);

    let (fiat_token, _) = local_token.deploy(@calldata).unwrap();
    let fiat_token = IHypERC20TestDispatcher { contract_address: fiat_token };

    let remote_token_address: felt252 = setup.remote_token.contract_address.into();
    fiat_token.enroll_remote_router(DESTINATION, remote_token_address.into());

    setup.primary_token.transfer(setup.local_token.contract_address, 1000 * E18);
    setup.primary_token.transfer(ALICE(), 1000 * E18);

    setup.local_token = fiat_token;
    enroll_remote_router(@setup);

    setup
}

#[test]
fn test_fiat_token_remote_transfer() {
    let setup = fiat_token_setup();

    let balance_before = setup.local_token.balance_of(ALICE());

    start_prank(CheatTarget::One((setup).primary_token.contract_address), ALICE());
    setup.primary_token.approve(setup.local_token.contract_address, TRANSFER_AMT);
    stop_prank(CheatTarget::One(setup.primary_token.contract_address));

    perform_remote_transfer_and_gas(@setup, REQUIRED_VALUE, TRANSFER_AMT, 0);
    let balance_after = setup.local_token.balance_of(ALICE());
    assert_eq!(balance_after, balance_before - TRANSFER_AMT);
}

#[test]
fn test_fiat_token_handle() {
    let setup = fiat_token_setup();
    handle_local_transfer(@setup, TRANSFER_AMT);
}
