use mocks::test_interchain_gas_payment::ITestInterchainGasPaymentDispatcherTrait;
use snforge_std::{
    declare, ContractClassTrait, CheatTarget, EventSpy, EventAssertions, spy_events, SpyOn,
    start_prank, stop_prank, EventFetcher, event_name_hash
};
use super::common::{
    setup, TOTAL_SUPPLY, DECIMALS, ORIGIN, TRANSFER_AMT, perform_remote_transfer_with_emit,
    perform_remote_transfer_and_gas, ALICE, BOB, E18, IHypERC20TestDispatcher,
    IHypERC20TestDispatcherTrait, enroll_remote_router, enroll_local_router,
    perform_remote_transfer, set_custom_gas_config, REQUIRED_VALUE, GAS_LIMIT
};

#[test]
fn test_erc20_total_supply() {
    let setup = setup();
    let erc20_token = setup.local_token;
    let total_supply = erc20_token.total_supply();
    assert_eq!(total_supply, TOTAL_SUPPLY);
}

#[test]
fn test_erc20_decimals() {
    let setup = setup();
    let erc20_token = setup.local_token;
    let decimals = erc20_token.decimals();
    assert_eq!(decimals, DECIMALS);
}

#[test]
fn test_erc20_local_transfer() {
    let setup = setup();
    let erc20_token = setup.local_token;
    let alice = erc20_token.balance_of(ALICE());
    let bob = erc20_token.balance_of(BOB());
    assert_eq!(alice, 1000 * E18);
    assert_eq!(bob, 0);

    start_prank(CheatTarget::One((setup).local_token.contract_address), ALICE());
    erc20_token.transfer(BOB(), 100 * E18);
    stop_prank(CheatTarget::One(erc20_token.contract_address));

    let alice = erc20_token.balance_of(ALICE());
    let bob = erc20_token.balance_of(BOB());
    assert_eq!(alice, 900 * E18);
    assert_eq!(bob, 100 * E18);
}

#[test]
fn test_erc20_remote_transfer() {
    let setup = setup();
    let erc20_token = setup.local_token;
    enroll_remote_router(@setup);
    enroll_local_router(@setup);

    let local_token_address: felt252 = setup.local_token.contract_address.into();
    setup.remote_token.enroll_remote_router(ORIGIN, local_token_address.into());

    let balance_before = erc20_token.balance_of(ALICE());
    perform_remote_transfer_and_gas(@setup, REQUIRED_VALUE, TRANSFER_AMT, 0);
    let balance_after = erc20_token.balance_of(ALICE());
    assert_eq!(balance_after, balance_before - TRANSFER_AMT);
}

#[test]
#[should_panic]
fn test_erc20_remote_transfer_invalid_amount() {
    let setup = setup();

    perform_remote_transfer(@setup, REQUIRED_VALUE, TRANSFER_AMT * 11);
}

#[test]
fn test_erc20_remote_transfer_with_custom_gas_config() {
    let setup = setup();
    let erc20_token = setup.local_token;
    enroll_remote_router(@setup);
    enroll_local_router(@setup);

    let local_token_address: felt252 = setup.local_token.contract_address.into();
    setup.remote_token.enroll_remote_router(ORIGIN, local_token_address.into());

    set_custom_gas_config(@setup);

    let gas_price = setup.igp.gas_price();
    let balance_before = erc20_token.balance_of(ALICE());
    perform_remote_transfer_and_gas(@setup, REQUIRED_VALUE, TRANSFER_AMT, GAS_LIMIT * gas_price);
    let balance_after = erc20_token.balance_of(ALICE());
    assert_eq!(balance_after, balance_before - TRANSFER_AMT);
}
