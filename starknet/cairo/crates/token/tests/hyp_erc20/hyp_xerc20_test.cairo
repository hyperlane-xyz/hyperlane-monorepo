use mocks::xerc20_test::{XERC20Test, IXERC20TestDispatcher, IXERC20TestDispatcherTrait};
use mocks::{test_erc20::{ITestERC20Dispatcher, ITestERC20DispatcherTrait},};
use snforge_std::{declare, ContractClassTrait, CheatTarget, start_prank, stop_prank,};
use starknet::ContractAddress;
use super::common::{
    Setup, TOTAL_SUPPLY, DECIMALS, ORIGIN, TRANSFER_AMT, ALICE, BOB, E18, REQUIRED_VALUE,
    DESTINATION, IHypERC20TestDispatcher, IHypERC20TestDispatcherTrait, setup,
    perform_remote_transfer_and_gas, enroll_remote_router, enroll_local_router,
    perform_remote_transfer, handle_local_transfer
};

fn setup_xerc20() -> Setup {
    let mut setup = setup();
    let default_ism = setup.implementation.interchain_security_module();

    let contract = declare("XERC20Test").unwrap();
    let mut calldata: Array<felt252> = array![];
    TOTAL_SUPPLY.serialize(ref calldata);
    DECIMALS.serialize(ref calldata);
    let (xerc20, _) = contract.deploy(@calldata).unwrap();
    setup.primary_token = ITestERC20Dispatcher { contract_address: xerc20 };

    let contract = declare("HypXERC20").unwrap();
    let (local_token, _) = contract
        .deploy(
            @array![
                setup.local_mailbox.contract_address.into(),
                xerc20.into(),
                starknet::get_contract_address().into(),
                setup.noop_hook.contract_address.into(),
                default_ism.into()
            ]
        )
        .unwrap();
    setup.local_token = IHypERC20TestDispatcher { contract_address: local_token };

    setup
        .local_token
        .enroll_remote_router(
            DESTINATION,
            Into::<ContractAddress, felt252>::into(setup.remote_token.contract_address).into()
        );
    setup.primary_token.transfer(local_token, 1000 * E18);
    setup.primary_token.transfer(ALICE(), 1000 * E18);
    setup
        .remote_token
        .enroll_remote_router(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(setup.local_token.contract_address).into()
        );
    setup
}

#[test]
fn test_remote_transfer() {
    let mut setup = setup_xerc20();
    let xerc20 = setup.local_token;
    start_prank(CheatTarget::One((setup).primary_token.contract_address), ALICE());
    setup.primary_token.approve(xerc20.contract_address, TRANSFER_AMT);
    stop_prank(CheatTarget::One((setup).primary_token.contract_address));

    let balance_before = xerc20.balance_of(ALICE());
    let total_supply_before = setup.primary_token.total_supply();
    perform_remote_transfer(@setup, REQUIRED_VALUE, TRANSFER_AMT);
    let balance_after = xerc20.balance_of(ALICE());
    let total_supply_after = setup.primary_token.total_supply();
    assert_eq!(total_supply_after, total_supply_before - TRANSFER_AMT);
    assert_eq!(balance_after, balance_before - TRANSFER_AMT);
}

#[test]
fn test_handle() {
    let mut setup = setup_xerc20();
    let xerc20 = setup.local_token;
    let balance_before = xerc20.balance_of(ALICE());
    let total_supply_before = setup.primary_token.total_supply();
    handle_local_transfer(@setup, TRANSFER_AMT);
    let balance_after = xerc20.balance_of(ALICE());
    let total_supply_after = setup.primary_token.total_supply();

    assert_eq!(total_supply_after, total_supply_before + TRANSFER_AMT);
    assert_eq!(balance_after, balance_before + TRANSFER_AMT);
}
