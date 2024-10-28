use alexandria_bytes::{Bytes, BytesTrait};
use contracts::interfaces::{
    ModuleType, IAggregationDispatcher, IAggregationDispatcherTrait,
    IInterchainSecurityModuleDispatcher, IInterchainSecurityModuleDispatcherTrait,
    IValidatorConfigurationDispatcher, IValidatorConfigurationDispatcherTrait,
};
use contracts::isms::aggregation::aggregation;
use contracts::libs::message::{Message, MessageTrait, HYPERLANE_VERSION};
use contracts::utils::utils::U256TryIntoContractAddress;

use openzeppelin::access::ownable::OwnableComponent;
use openzeppelin::access::ownable::interface::{IOwnableDispatcher, IOwnableDispatcherTrait};
use snforge_std::{start_prank, CheatTarget};
use starknet::ContractAddress;
use super::super::setup::{
    setup_aggregation, OWNER, setup_messageid_multisig_ism, get_message_and_signature, LOCAL_DOMAIN,
    DESTINATION_DOMAIN, build_messageid_metadata, VALID_OWNER, VALID_RECIPIENT, setup_noop_ism,
    MODULES, CONTRACT_MODULES
};

#[test]
fn test_aggregation_module_type() {
    let threshold = 2;
    let aggregation = setup_aggregation(MODULES(), threshold);
    assert(
        aggregation.module_type() == ModuleType::AGGREGATION(aggregation.contract_address),
        'Aggregation: Wrong module type'
    );
}

#[test]
#[should_panic]
fn test_aggregation_initialize_with_too_many_modules() {
    let threshold = 2;
    let mut modules = array![];
    let mut cur_idx = 0;
    loop {
        if (cur_idx == 256) {
            break;
        }
        modules.append('module_1'.into());
        cur_idx += 1;
    };
    setup_aggregation(modules.span(), threshold);
}


#[test]
#[should_panic]
fn test_setup_aggregation_with_null_module_address() {
    let threshold = 2;
    let modules: Span<felt252> = array![0, 'module_1'].span();
    setup_aggregation(modules, threshold);
}

#[test]
fn test_get_modules() {
    let threshold = 2;
    let aggregation = setup_aggregation(MODULES(), threshold);
    let ownable = IOwnableDispatcher { contract_address: aggregation.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    assert(aggregation.get_modules() == CONTRACT_MODULES(), 'set modules failed');
}


#[test]
fn test_aggregation_verify() {
    let threshold = 2;

    // MESSAGEID 

    let array = array![
        0x01020304050607080910111213141516,
        0x01020304050607080910111213141516,
        0x01020304050607080910000000000000
    ];
    let message_body = BytesTrait::new(42, array);
    let message = Message {
        version: HYPERLANE_VERSION,
        nonce: 0,
        origin: LOCAL_DOMAIN,
        sender: VALID_OWNER(),
        destination: DESTINATION_DOMAIN,
        recipient: VALID_RECIPIENT(),
        body: message_body.clone()
    };
    let (_, validators_address, _) = get_message_and_signature();
    let (messageid, _) = setup_messageid_multisig_ism(validators_address.span(), threshold);
    let origin_merkle_tree: u256 = 'origin_merkle_tree_hook'.try_into().unwrap();
    let root: u256 = 'root'.try_into().unwrap();
    let index = 1;
    let message_id_metadata = build_messageid_metadata(origin_merkle_tree, root, index);
    // Noop ism
    let noop_ism = setup_noop_ism();
    let aggregation = setup_aggregation(
        array![messageid.contract_address.into(), noop_ism.contract_address.into(),].span(),
        threshold.try_into().unwrap()
    );
    let ownable = IOwnableDispatcher { contract_address: aggregation.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    let mut concat_metadata = BytesTrait::new_empty();
    concat_metadata.append_u128(0x00000010000001A0000001A0000001A9);
    concat_metadata.concat(@message_id_metadata);
    // dummy metadata for noop ism
    concat_metadata.concat(@message_id_metadata);
    assert(aggregation.verify(concat_metadata, message), 'Aggregation: verify failed');
}

