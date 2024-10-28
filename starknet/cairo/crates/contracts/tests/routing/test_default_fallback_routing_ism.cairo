use alexandria_bytes::{Bytes, BytesTrait};
use contracts::interfaces::{
    ModuleType, IInterchainSecurityModuleDispatcher, IInterchainSecurityModuleDispatcherTrait,
    IRoutingIsmDispatcher, IRoutingIsmDispatcherTrait, IDomainRoutingIsmDispatcher,
    IDomainRoutingIsmDispatcherTrait, IValidatorConfigurationDispatcher,
    IValidatorConfigurationDispatcherTrait, IMailboxClientDispatcher, IMailboxClientDispatcherTrait,
    IMailboxDispatcher, IMailboxDispatcherTrait
};
use contracts::libs::message::{Message, HYPERLANE_VERSION};
use contracts::utils::utils::U256TryIntoContractAddress;
use openzeppelin::access::ownable::interface::{IOwnableDispatcher, IOwnableDispatcherTrait};
use snforge_std::{start_prank, CheatTarget, ContractClassTrait, declare};
use starknet::{ContractAddress, contract_address_const};
use super::super::setup::{
    OWNER, setup_default_fallback_routing_ism, build_messageid_metadata, LOCAL_DOMAIN, VALID_OWNER,
    VALID_RECIPIENT, DESTINATION_DOMAIN, setup_messageid_multisig_ism, get_message_and_signature,
    setup_mailbox, MAILBOX
};

#[test]
fn test_initialize() {
    let _domains: Array<u32> = array![12345, 1123322, 312441];
    let _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    assert(fallback_routing_ism.domains() == _domains.span(), 'wrong domains init');
    let mut cur_idx = 0;
    loop {
        if (cur_idx == _domains.len()) {
            break ();
        }
        assert_eq!(*_modules.at(cur_idx), fallback_routing_ism.module(*_domains.at(cur_idx)));
        cur_idx += 1;
    }
}


#[test]
fn get_default_module() {
    let (mailbox, _, _, _) = setup_mailbox(MAILBOX(), Option::None, Option::None);
    let default_fallback_routing_ism = declare("default_fallback_routing_ism").unwrap();
    let params: Array<felt252> = array![
        OWNER().try_into().unwrap(), mailbox.contract_address.into()
    ];
    let (default_fallback_routing_ism_addr, _) = default_fallback_routing_ism
        .deploy(@params)
        .unwrap();
    let test_address = contract_address_const::<0x1331341>();
    let dispatcher = IDomainRoutingIsmDispatcher {
        contract_address: default_fallback_routing_ism_addr
    };
    let mailbox = IMailboxDispatcher { contract_address: mailbox.contract_address };
    let ownable = IOwnableDispatcher { contract_address: mailbox.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    mailbox.set_default_ism(test_address);
    assert_eq!(dispatcher.module(1234), test_address);
}
#[test]
#[should_panic(expected: ('Caller is not the owner',))]
fn test_initialize_fails_if_caller_not_owner() {
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let _domains = array![12345, 1123322, 312441];
    let _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    fallback_routing_ism.initialize(_domains.span(), _modules.span())
}

#[test]
#[should_panic(expected: ('Module cannot be zero',))]
fn test_initialize_fails_if_module_is_zero() {
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let _domains = array![12345, 1123322, 312441];
    let _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0>()
    ];
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span())
}

#[test]
#[should_panic(expected: ('Length mismatch',))]
fn test_initialize_fails_if_length_mismatch() {
    let _domains = array![12345, 1123322, 312441, 131321];
    let _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
}


#[test]
fn test_remove_domain() {
    let mut _domains = array![12345, 1123322, 312441];
    let _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    fallback_routing_ism.remove(12345);
    _domains.pop_front().unwrap();
    assert(_domains.span() == fallback_routing_ism.domains(), 'wrong domain del');
}
#[test]
fn test_remove_domain_module_check() {
    let mut _domains = array![12345, 1123322, 312441];
    let _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    fallback_routing_ism.remove(12345);
    let mailbox_dispatcher = IMailboxDispatcher { contract_address: MAILBOX() };
    assert_eq!(fallback_routing_ism.module(12345), mailbox_dispatcher.get_default_ism());
}


#[test]
#[should_panic(expected: ('Domain not found',))]
fn test_remove_domain_fails_if_domain_not_found() {
    let _domains = array![12345, 1123322, 312441];
    let _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    fallback_routing_ism.remove(1);
}

#[test]
#[should_panic(expected: ('Caller is not the owner',))]
fn test_remove_domain_fails_if_caller_not_owner() {
    let _domains = array![12345, 1123322, 312441];
    let _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    fallback_routing_ism.remove(12345);
}


#[test]
fn test_set_domain_and_module() {
    let mut _domains = array![12345, 1123322, 312441];
    let mut _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    let new_domain = 111111;
    let new_module = contract_address_const::<0x2134242342342>();
    fallback_routing_ism.set(new_domain, new_module);
    _domains.append(new_domain);
    _modules.append(new_module);
    assert(_domains.span() == fallback_routing_ism.domains(), 'wrong domain add');
    let mut cur_idx = 0;
    loop {
        if (cur_idx == _domains.len()) {
            break ();
        }
        assert_eq!(*_modules.at(cur_idx), fallback_routing_ism.module(*_domains.at(cur_idx)));
        cur_idx += 1;
    }
}

#[test]
#[should_panic(expected: ('Caller is not the owner',))]
fn test_set_domain_and_module_fails_if_caller_is_not_owner() {
    let mut _domains = array![12345, 1123322, 312441];
    let mut _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    let new_domain = 111111;
    let new_module = contract_address_const::<0x2134242342342>();
    fallback_routing_ism.set(new_domain, new_module);
}


#[test]
fn test_route_ism() {
    let mut message = Message {
        version: 3_u8,
        nonce: 0_u32,
        origin: 12345,
        sender: 'SENDER'.try_into().unwrap(),
        destination: 0_u32,
        recipient: 'RECIPIENT'.try_into().unwrap(),
        body: BytesTrait::new_empty(),
    };
    let mut _domains = array![12345, 1123322, 312441];
    let mut _modules: Array<ContractAddress> = array![
        contract_address_const::<0x111>(),
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (_, ism, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    assert_eq!(ism.route(message), *_modules.at(0));
    message =
        Message {
            version: 3_u8,
            nonce: 0_u32,
            origin: 1123322,
            sender: 'SENDER'.try_into().unwrap(),
            destination: 0_u32,
            recipient: 'RECIPIENT'.try_into().unwrap(),
            body: BytesTrait::new_empty(),
        };
    assert_eq!(ism.route(message), *_modules.at(1));
    message =
        Message {
            version: 3_u8,
            nonce: 0_u32,
            origin: 312441,
            sender: 'SENDER'.try_into().unwrap(),
            destination: 0_u32,
            recipient: 'RECIPIENT'.try_into().unwrap(),
            body: BytesTrait::new_empty(),
        };
    assert_eq!(ism.route(message), *_modules.at(2));
    message =
        Message {
            version: 3_u8,
            nonce: 0_u32,
            origin: 1,
            sender: 'SENDER'.try_into().unwrap(),
            destination: 0_u32,
            recipient: 'RECIPIENT'.try_into().unwrap(),
            body: BytesTrait::new_empty(),
        };
    let mailbox_dispatcher = IMailboxDispatcher { contract_address: MAILBOX() };
    assert_eq!(ism.route(message), mailbox_dispatcher.get_default_ism());
}


#[test]
fn test_module_type() {
    let (ism, _, _) = setup_default_fallback_routing_ism();
    assert_eq!(ism.module_type(), ModuleType::ROUTING(ism.contract_address));
}

// for this test, we will reuse existing tests
#[test]
fn test_verify() {
    let threshold = 4;
    // ISM MESSAGE AND METADATA CONFIGURATION
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

    // ROUTING TESTING
    let mut _domains = array![LOCAL_DOMAIN, 1123322, 312441];
    let mut _modules: Array<ContractAddress> = array![
        messageid.contract_address,
        contract_address_const::<0x222>(),
        contract_address_const::<0x333>()
    ];
    let (ism, _, fallback_routing_ism) = setup_default_fallback_routing_ism();
    let ownable = IOwnableDispatcher { contract_address: fallback_routing_ism.contract_address };
    start_prank(CheatTarget::One(ownable.contract_address), OWNER().try_into().unwrap());
    fallback_routing_ism.initialize(_domains.span(), _modules.span());
    assert_eq!(ism.verify(metadata, message), true);
}
