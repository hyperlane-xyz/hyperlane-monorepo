use alexandria_bytes::{Bytes, BytesTrait};
use contracts::interfaces::IMessageRecipientDispatcherTrait;
use contracts::interfaces::{
    IMailbox, IMailboxDispatcher, IMailboxDispatcherTrait, ModuleType,
    IInterchainSecurityModuleDispatcher, IInterchainSecurityModuleDispatcherTrait,
    IInterchainSecurityModule, IValidatorConfigurationDispatcher,
    IValidatorConfigurationDispatcherTrait,
};
use contracts::libs::message::{Message, MessageTrait, HYPERLANE_VERSION};
use contracts::libs::multisig::message_id_ism_metadata::message_id_ism_metadata::MessageIdIsmMetadata;
use contracts::mailbox::mailbox;
use contracts::utils::utils::U256TryIntoContractAddress;
use core::array::ArrayTrait;
use core::array::SpanTrait;
use openzeppelin::access::ownable::OwnableComponent;
use openzeppelin::access::ownable::interface::{IOwnableDispatcher, IOwnableDispatcherTrait};
use snforge_std::cheatcodes::events::EventAssertions;
use snforge_std::{start_prank, CheatTarget};
use super::super::setup::{
    setup_messageid_multisig_ism, OWNER, NEW_OWNER, VALIDATOR_ADDRESS_1, VALIDATOR_ADDRESS_2,
    get_message_and_signature, LOCAL_DOMAIN, DESTINATION_DOMAIN, RECIPIENT_ADDRESS,
    build_messageid_metadata, VALID_OWNER, VALID_RECIPIENT, build_fake_messageid_metadata
};


#[test]
fn test_set_validators() {
    let threshold = 2;
    let new_validators: Array<felt252> = array![
        VALIDATOR_ADDRESS_1().into(), VALIDATOR_ADDRESS_2().into()
    ];
    let (_, validators) = setup_messageid_multisig_ism(new_validators.span(), threshold);
    let ownable = IOwnableDispatcher { contract_address: validators.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    let validators_span = validators.get_validators();
    assert_eq!(*validators_span.at(0).into(), (*new_validators.at(0)).try_into().unwrap());
    assert_eq!(*validators_span.at(1).into(), (*new_validators.at(1)).try_into().unwrap());
}

#[test]
fn test_set_threshold() {
    let threshold = 3;
    let (_, validators) = setup_messageid_multisig_ism(array!['validator_1'].span(), threshold);
    assert(validators.get_threshold() == threshold, 'wrong validator threshold');
}


#[test]
#[should_panic]
fn test_set_validators_fails_if_null_validator() {
    let threshold = 2;
    let new_validators: Span<felt252> = array![VALIDATOR_ADDRESS_1().try_into().unwrap(), 0].span();
    setup_messageid_multisig_ism(new_validators, threshold);
}


#[test]
fn test_message_id_ism_metadata() {
    let origin_merkle_tree: u256 = 'origin_merkle_tree_hook'.try_into().unwrap();
    let root: u256 = 'root'.try_into().unwrap();
    let y_parity = 0x01;
    let index = 1;
    let (_, _, signatures) = get_message_and_signature();
    let metadata = build_messageid_metadata(origin_merkle_tree, root, index);
    assert(
        MessageIdIsmMetadata::origin_merkle_tree_hook(metadata.clone()) == origin_merkle_tree,
        'wrong merkle tree hook'
    );
    assert(MessageIdIsmMetadata::root(metadata.clone()) == root, 'wrong root');
    assert(MessageIdIsmMetadata::index(metadata.clone()) == index, 'wrong index');
    let mut cur_idx = 0;
    loop {
        if (cur_idx == signatures.len()) {
            break ();
        }
        assert(
            MessageIdIsmMetadata::signature_at(
                metadata.clone(), cur_idx
            ) == (y_parity, *signatures.at(cur_idx).r, *signatures.at(cur_idx).s),
            'wrong signature '
        );
        cur_idx += 1;
    }
}


#[test]
fn test_message_id_multisig_module_type() {
    let threshold = 4;
    let (messageid, _) = setup_messageid_multisig_ism(array!['validator_1'].span(), threshold);
    assert(
        messageid.module_type() == ModuleType::MESSAGE_ID_MULTISIG(messageid.contract_address),
        'Wrong module type'
    );
}


#[test]
fn test_message_id_multisig_verify_with_4_valid_signatures() {
    let threshold = 4;
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
    let metadata = build_messageid_metadata(origin_merkle_tree, root, index);
    assert(messageid.verify(metadata, message) == true, 'verification failed');
}


#[test]
#[should_panic(expected: ('No match for given signature',))]
fn test_message_id_multisig_verify_with_insufficient_valid_signatures() {
    let threshold = 4;
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
    let mut metadata = build_messageid_metadata(origin_merkle_tree, root, index);
    // introduce an error for the signature
    metadata.update_at(80, 0);
    assert(messageid.verify(metadata, message) == true, 'verification failed');
}


#[test]
#[should_panic(expected: ('Empty metadata',))]
fn test_message_id_multisig_verify_with_empty_metadata() {
    let threshold = 4;
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
    let bytes_metadata = BytesTrait::new_empty();
    assert(messageid.verify(bytes_metadata, message) == true, 'verification failed');
}


#[test]
#[should_panic(expected: ('No match for given signature',))]
fn test_message_id_multisig_verify_with_4_valid_signatures_fails_if_duplicate_signatures() {
    let threshold = 4;
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
    let metadata = build_fake_messageid_metadata(origin_merkle_tree, root, index);
    assert(messageid.verify(metadata, message) == true, 'verification failed');
}
