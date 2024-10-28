use alexandria_bytes::{Bytes, BytesTrait};
use contracts::interfaces::{
    Types, IProtocolFeeDispatcher, IProtocolFeeDispatcherTrait, IPostDispatchHookDispatcher,
    IPostDispatchHookDispatcherTrait, ETH_ADDRESS
};
use contracts::libs::message::{Message, MessageTrait};
use contracts::utils::utils::U256TryIntoContractAddress;
use openzeppelin::access::ownable::interface::{IOwnableDispatcher, IOwnableDispatcherTrait};
use openzeppelin::token::erc20::interface::{ERC20ABIDispatcher, ERC20ABIDispatcherTrait};
use snforge_std::{start_prank, CheatTarget, stop_prank};
use super::super::setup::{
    setup_protocol_fee, OWNER, MAX_PROTOCOL_FEE, BENEFICIARY, PROTOCOL_FEE, INITIAL_SUPPLY,
    setup_mock_token
};


#[test]
fn test_hook_type() {
    let (_, protocol_fee) = setup_protocol_fee();
    assert_eq!(protocol_fee.hook_type(), Types::PROTOCOL_FEE(()));
}

#[test]
fn test_set_protocol_fee() {
    let (protocol_fee, _) = setup_protocol_fee();
    let ownable = IOwnableDispatcher { contract_address: protocol_fee.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    let new_protocol_fee = 20000;
    protocol_fee.set_protocol_fee(new_protocol_fee);
    assert_eq!(protocol_fee.get_protocol_fee(), new_protocol_fee);
}


#[test]
#[should_panic(expected: ('Caller is not the owner',))]
fn test_set_protocol_fee_fails_if_not_owner() {
    let (protocol_fee, _) = setup_protocol_fee();
    let new_protocol_fee = 20000;
    protocol_fee.set_protocol_fee(new_protocol_fee);
}

#[test]
#[should_panic(expected: ('Exceeds max protocol fee',))]
fn test_set_protocol_fee_fails_if_higher_than_max() {
    let (protocol_fee, _) = setup_protocol_fee();
    let ownable = IOwnableDispatcher { contract_address: protocol_fee.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    let new_protocol_fee = MAX_PROTOCOL_FEE + 1;
    protocol_fee.set_protocol_fee(new_protocol_fee);
    assert_eq!(protocol_fee.get_protocol_fee(), new_protocol_fee);
}


#[test]
fn test_set_beneficiary() {
    let (protocol_fee, _) = setup_protocol_fee();
    let ownable = IOwnableDispatcher { contract_address: protocol_fee.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    let new_beneficiary = 'NEW_BENEFICIARY'.try_into().unwrap();
    protocol_fee.set_beneficiary(new_beneficiary);
    assert_eq!(protocol_fee.get_beneficiary(), new_beneficiary);
}


#[test]
#[should_panic(expected: ('Caller is not the owner',))]
fn test_set_beneficiary_fails_if_not_owner() {
    let (protocol_fee, _) = setup_protocol_fee();
    let new_beneficiary = 'NEW_BENEFICIARY'.try_into().unwrap();
    protocol_fee.set_beneficiary(new_beneficiary);
}


#[test]
fn test_collect_protocol_fee() {
    let fee_token = setup_mock_token();
    let (protocol_fee, _) = setup_protocol_fee();
    let ownable = IOwnableDispatcher { contract_address: fee_token.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());

    // First transfer the token to the contract
    fee_token.transfer(protocol_fee.contract_address, PROTOCOL_FEE);
    assert_eq!(fee_token.balanceOf(protocol_fee.contract_address), PROTOCOL_FEE);
    stop_prank(CheatTarget::One(ownable.contract_address));

    protocol_fee.collect_protocol_fees();
    assert_eq!(fee_token.balanceOf(BENEFICIARY()), PROTOCOL_FEE);
    assert_eq!(fee_token.balanceOf(protocol_fee.contract_address), 0);
}

#[test]
#[should_panic(expected: ('Insufficient balance',))]
fn test_collect_protocol_fee_fails_if_insufficient_balance() {
    setup_mock_token();
    let (protocol_fee, _) = setup_protocol_fee();
    protocol_fee.collect_protocol_fees();
}


#[test]
fn test_supports_metadata() {
    let mut metadata = BytesTrait::new_empty();
    let (_, post_dispatch_hook) = setup_protocol_fee();
    assert_eq!(post_dispatch_hook.supports_metadata(metadata.clone()), true);
    let variant = 1;
    metadata.append_u16(variant);
    assert_eq!(post_dispatch_hook.supports_metadata(metadata), true);
    metadata = BytesTrait::new_empty();
    metadata.append_u16(variant + 1);
    assert_eq!(post_dispatch_hook.supports_metadata(metadata), false);
}


#[test]
#[should_panic(expected: ('Invalid metadata variant',))]
fn test_post_dispatch_fails_if_invalid_variant() {
    let fee_token = ERC20ABIDispatcher { contract_address: ETH_ADDRESS() };
    let (_, post_dispatch_hook) = setup_protocol_fee();
    let ownable = IOwnableDispatcher { contract_address: fee_token.contract_address };
    let mut metadata = BytesTrait::new_empty();
    let variant = 2;
    metadata.append_u16(variant);
    let message = MessageTrait::default();
    stop_prank(CheatTarget::One(ownable.contract_address));
    let ownable = IOwnableDispatcher { contract_address: post_dispatch_hook.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    post_dispatch_hook.post_dispatch(metadata, message, PROTOCOL_FEE);
}


#[test]
fn test_quote_dispatch() {
    let (_, post_dispatch_hook) = setup_protocol_fee();
    let mut metadata = BytesTrait::new_empty();
    let variant = 1;
    let message = MessageTrait::default();
    metadata.append_u16(variant);
    assert_eq!(post_dispatch_hook.quote_dispatch(metadata, message), PROTOCOL_FEE);
}


#[test]
#[should_panic(expected: ('Invalid metadata variant',))]
fn test_quote_dispatch_fails_if_invalid_variant() {
    let (_, post_dispatch_hook) = setup_protocol_fee();
    let mut metadata = BytesTrait::new_empty();
    let variant = 2;
    metadata.append_u16(variant);
    let message = MessageTrait::default();
    post_dispatch_hook.quote_dispatch(metadata, message);
}
