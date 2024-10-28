use alexandria_bytes::{Bytes, BytesTrait};
use contracts::interfaces::{
    IMailboxDispatcher, IMailboxDispatcherTrait, IMessageRecipientDispatcher,
    IMessageRecipientDispatcherTrait, IInterchainSecurityModule,
    IInterchainSecurityModuleDispatcher, IInterchainSecurityModuleDispatcherTrait,
    IValidatorAnnounceDispatcher, IValidatorAnnounceDispatcherTrait, IMailboxClientDispatcher,
    IMailboxClientDispatcherTrait, IAggregationDispatcher, IAggregationDispatcherTrait,
    IValidatorConfigurationDispatcher, IMerkleTreeHookDispatcher, IMerkleTreeHookDispatcherTrait,
    IPostDispatchHookDispatcher, IProtocolFeeDispatcher, IPostDispatchHookDispatcherTrait,
    IProtocolFeeDispatcherTrait, IMockValidatorAnnounceDispatcher,
    ISpecifiesInterchainSecurityModuleDispatcher, ISpecifiesInterchainSecurityModuleDispatcherTrait,
    IRoutingIsmDispatcher, IRoutingIsmDispatcherTrait, IDomainRoutingIsmDispatcher,
    IDomainRoutingIsmDispatcherTrait, IPausableIsmDispatcher, IPausableIsmDispatcherTrait,
    ETH_ADDRESS
};
use contracts::libs::multisig::merkleroot_ism_metadata::merkleroot_ism_metadata::MERKLE_PROOF_ITERATION;
use openzeppelin::account::utils::signature::EthSignature;
use openzeppelin::token::erc20::interface::{ERC20ABI, ERC20ABIDispatcher, ERC20ABIDispatcherTrait};
use snforge_std::{
    declare, ContractClassTrait, CheatTarget, EventSpy, EventAssertions, spy_events, SpyOn
};
use starknet::{ContractAddress, contract_address_const, EthAddress};

pub const LOCAL_DOMAIN: u32 = 534352;
pub const DESTINATION_DOMAIN: u32 = 9841001;
pub const MAX_PROTOCOL_FEE: u256 = 1000000000;
pub const PROTOCOL_FEE: u256 = 1000000;
pub const INITIAL_SUPPLY: u256 = 10000000000;


pub fn OWNER() -> u256 {
    'OWNER'.into()
}

pub fn NEW_OWNER() -> u256 {
    'NEW_OWNER'.into()
}

pub fn VALID_OWNER() -> u256 {
    0x1a4bcca63b5e8a46da3abe2080f75c16c18467d5838f00b375d9ba4c7c313dd
}

pub fn VALID_RECIPIENT() -> u256 {
    0x1d35915d0abec0a28990198bb32aa570e681e7eb41a001c0094c7c36a712671
}

pub fn DEFAULT_ISM() -> ContractAddress {
    contract_address_const::<'DEFAULT_ISM'>()
}

pub fn DEFAULT_HOOK() -> ContractAddress {
    contract_address_const::<'DEFAULT_HOOK'>()
}

pub fn REQUIRED_HOOK() -> ContractAddress {
    contract_address_const::<'REQUIRED_HOOK'>()
}

pub fn NEW_DEFAULT_ISM() -> ContractAddress {
    contract_address_const::<'NEW_DEFAULT_ISM'>()
}

pub fn NEW_DEFAULT_HOOK() -> ContractAddress {
    contract_address_const::<'NEW_DEFAULT_HOOK'>()
}

pub fn NEW_REQUIRED_HOOK() -> ContractAddress {
    contract_address_const::<'NEW_REQUIRED_HOOK'>()
}

pub fn RECIPIENT_ADDRESS() -> u256 {
    'RECIPIENT_ADDRESS'.into()
}

pub fn VALIDATOR_ADDRESS_1() -> EthAddress {
    'VALIDATOR_ADDRESS_1'.try_into().unwrap()
}

pub fn VALIDATOR_ADDRESS_2() -> EthAddress {
    'VALIDATOR_ADDRESS_2'.try_into().unwrap()
}

pub fn BENEFICIARY() -> ContractAddress {
    'BENEFICIARY'.try_into().unwrap()
}

pub fn MAILBOX() -> ContractAddress {
    'MAILBOX'.try_into().unwrap()
}

pub fn DESTINATION_MAILBOX() -> ContractAddress {
    'DESTINATION_MAILBOX'.try_into().unwrap()
}

pub fn MAILBOX_CLIENT() -> ContractAddress {
    'MAILBOX_CLIENT'.try_into().unwrap()
}
pub fn MODULES() -> Span<felt252> {
    array!['module_1', 'module_2'].span()
}

pub fn CONTRACT_MODULES() -> Span<ContractAddress> {
    let module_1 = 'module_1'.try_into().unwrap();
    let module_2 = 'module_2'.try_into().unwrap();
    array![module_1, module_2].span()
}
pub fn TEST_PROOF() -> Span<u256> {
    array![
        0x09020304050607080910111213141516,
        0x01020304050607080920111213141516,
        0x01020304050607080910000000000000,
        0x02010304050607080910111213141516,
        0x03000000000000000000000000000000,
        0x09020304050607080910111213141516,
        0x01020304050607080920111213141516,
        0x01020304050607080910000000000000,
        0x02010304050607080910111213141516,
        0x03000000000000000000000000000000,
        0x09020304050607080910111213141516,
        0x01020304050607080920111213141516,
        0x01020304050607080910000000000000,
        0x02010304050607080910111213141516,
        0x03000000000000000000000000000000,
        0x09020304050607080910111213141516,
        0x01020304050607080920111213141516,
        0x01020304050607080910000000000000,
        0x02010304050607080910111213141516,
        0x03000000000000000000000000000000,
        0x09020304050607080910111213141516,
        0x01020304050607080920111213141516,
        0x01020304050607080910000000000000,
        0x02010304050607080910111213141516,
        0x03000000000000000000000000000000,
        0x09020304050607080910111213141516,
        0x01020304050607080920111213141516,
        0x01020304050607080910000000000000,
        0x02010304050607080910111213141516,
        0x03000000000000000000000000000000,
        0x09020304050607080910111213141516,
        0x01020304050607080920111213141516,
    ]
        .span()
}
pub fn setup_mailbox(
    mailbox_address: ContractAddress,
    _required_hook: Option<ContractAddress>,
    _default_mock_hook: Option<ContractAddress>
) -> (
    IMailboxDispatcher, EventSpy, IPostDispatchHookDispatcher, IInterchainSecurityModuleDispatcher
) {
    let domain = if (mailbox_address == MAILBOX()) {
        LOCAL_DOMAIN
    } else {
        DESTINATION_DOMAIN
    };
    let mailbox_class = declare("mailbox").unwrap();
    let required_hook = match _required_hook {
        Option::Some(address) => address,
        Option::None => {
            let mock_hook_dispatcher = setup_mock_hook();
            mock_hook_dispatcher.contract_address
        }
    };
    let default_hook = match _default_mock_hook {
        Option::Some(address) => address,
        Option::None => { required_hook }
    };
    let mock_ism = setup_mock_ism();
    setup_mock_token();
    let params: Array<felt252> = array![
        domain.into(),
        OWNER().try_into().unwrap(),
        mock_ism.contract_address.into(),
        default_hook.into(),
        required_hook.into()
    ];
    mailbox_class.deploy_at(@params, mailbox_address).unwrap();
    let mut spy = spy_events(SpyOn::One(mailbox_address));
    (
        IMailboxDispatcher { contract_address: mailbox_address },
        spy,
        IPostDispatchHookDispatcher { contract_address: required_hook },
        mock_ism
    )
}

pub fn mock_setup(
    mock_ism_address: ContractAddress
) -> (IMessageRecipientDispatcher, ISpecifiesInterchainSecurityModuleDispatcher,) {
    let message_recipient_class = declare("message_recipient").unwrap();
    let (message_recipient_addr, _) = message_recipient_class
        .deploy(@array![mock_ism_address.into()])
        .unwrap();
    (
        IMessageRecipientDispatcher { contract_address: message_recipient_addr },
        ISpecifiesInterchainSecurityModuleDispatcher { contract_address: message_recipient_addr },
    )
}

pub fn setup_mock_ism() -> IInterchainSecurityModuleDispatcher {
    let mock_ism = declare("ism").unwrap();
    let (mock_ism_addr, _) = mock_ism.deploy(@array![]).unwrap();
    IInterchainSecurityModuleDispatcher { contract_address: mock_ism_addr }
}
pub fn setup_messageid_multisig_ism(
    validators: Span<felt252>, threshold: u32
) -> (IInterchainSecurityModuleDispatcher, IValidatorConfigurationDispatcher) {
    let messageid_multisig_class = declare("messageid_multisig_ism").unwrap();
    let mut parameters = Default::default();
    let owner: felt252 = OWNER().try_into().unwrap();
    Serde::serialize(@owner, ref parameters);
    Serde::serialize(@validators, ref parameters);
    Serde::serialize(@threshold, ref parameters);
    let (messageid_multisig_addr, _) = messageid_multisig_class.deploy(@parameters).unwrap();
    (
        IInterchainSecurityModuleDispatcher { contract_address: messageid_multisig_addr },
        IValidatorConfigurationDispatcher { contract_address: messageid_multisig_addr }
    )
}


pub fn setup_merkleroot_multisig_ism(
    validators: Span<felt252>, threshold: u32
) -> (IInterchainSecurityModuleDispatcher, IValidatorConfigurationDispatcher) {
    let merkleroot_multisig_class = declare("merkleroot_multisig_ism").unwrap();
    let mut parameters = Default::default();
    let owner: felt252 = OWNER().try_into().unwrap();
    Serde::serialize(@owner, ref parameters);
    Serde::serialize(@validators, ref parameters);
    Serde::serialize(@threshold, ref parameters);
    let (merkleroot_multisig_addr, _) = merkleroot_multisig_class.deploy(@parameters).unwrap();
    (
        IInterchainSecurityModuleDispatcher { contract_address: merkleroot_multisig_addr },
        IValidatorConfigurationDispatcher { contract_address: merkleroot_multisig_addr }
    )
}


pub fn setup_mailbox_client() -> IMailboxClientDispatcher {
    let (mailbox, _, _, _) = setup_mailbox(MAILBOX(), Option::None, Option::None);
    let mailboxclient_class = declare("mailboxclient").unwrap();
    let params: Array<felt252> = array![
        mailbox.contract_address.into(), OWNER().try_into().unwrap()
    ];
    let res = mailboxclient_class.deploy_at(@params, MAILBOX_CLIENT());
    if (res.is_err()) {
        panic(res.unwrap_err());
    }
    let (mailboxclient_addr, _) = res.unwrap();
    IMailboxClientDispatcher { contract_address: mailboxclient_addr }
}

pub fn setup_default_fallback_routing_ism() -> (
    IInterchainSecurityModuleDispatcher, IRoutingIsmDispatcher, IDomainRoutingIsmDispatcher
) {
    let (mailbox, _, _, _) = setup_mailbox(MAILBOX(), Option::None, Option::None);
    let default_fallback_routing_ism = declare("default_fallback_routing_ism").unwrap();
    let params = array![OWNER().try_into().unwrap(), mailbox.contract_address.into()];
    let (default_fallback_routing_ism_addr, _) = default_fallback_routing_ism
        .deploy(@params)
        .unwrap();
    (
        IInterchainSecurityModuleDispatcher { contract_address: default_fallback_routing_ism_addr },
        IRoutingIsmDispatcher { contract_address: default_fallback_routing_ism_addr },
        IDomainRoutingIsmDispatcher { contract_address: default_fallback_routing_ism_addr }
    )
}

pub fn setup_domain_routing_ism() -> (
    IInterchainSecurityModuleDispatcher, IRoutingIsmDispatcher, IDomainRoutingIsmDispatcher
) {
    let domain_routing_ism = declare("domain_routing_ism").unwrap();
    let (domain_routing_ism_addr, _) = domain_routing_ism
        .deploy(@array![OWNER().try_into().unwrap()])
        .unwrap();
    (
        IInterchainSecurityModuleDispatcher { contract_address: domain_routing_ism_addr },
        IRoutingIsmDispatcher { contract_address: domain_routing_ism_addr },
        IDomainRoutingIsmDispatcher { contract_address: domain_routing_ism_addr }
    )
}

pub fn setup_validator_announce() -> (IValidatorAnnounceDispatcher, EventSpy) {
    let validator_announce_class = declare("validator_announce").unwrap();
    let (mailbox, _, _, _) = setup_mailbox(MAILBOX(), Option::None, Option::None);
    let (validator_announce_addr, _) = validator_announce_class
        .deploy(@array![mailbox.contract_address.into(), OWNER().try_into().unwrap()])
        .unwrap();
    let mut spy = spy_events(SpyOn::One(validator_announce_addr));
    (IValidatorAnnounceDispatcher { contract_address: validator_announce_addr }, spy)
}

pub fn setup_mock_validator_announce(
    mailbox_address: ContractAddress, domain: u32
) -> IMockValidatorAnnounceDispatcher {
    let validator_announce_class = declare("mock_validator_announce").unwrap();
    let (validator_announce_addr, _) = validator_announce_class
        .deploy(@array![mailbox_address.into(), domain.into()])
        .unwrap();
    IMockValidatorAnnounceDispatcher { contract_address: validator_announce_addr }
}

pub fn setup_aggregation(modules: Span<felt252>, threshold: u8) -> IAggregationDispatcher {
    let aggregation_class = declare("aggregation").unwrap();
    let mut parameters = Default::default();
    let owner: felt252 = OWNER().try_into().unwrap();
    Serde::serialize(@owner, ref parameters);
    Serde::serialize(@modules, ref parameters);
    Serde::serialize(@threshold, ref parameters);
    let (aggregation_addr, _) = aggregation_class.deploy(@parameters).unwrap();
    IAggregationDispatcher { contract_address: aggregation_addr }
}

pub fn setup_merkle_tree_hook() -> (
    IMerkleTreeHookDispatcher, IPostDispatchHookDispatcher, EventSpy
) {
    let (mailbox, _, _, _) = setup_mailbox(MAILBOX(), Option::None, Option::None);
    let merkle_tree_hook_class = declare("merkle_tree_hook").unwrap();
    let res = merkle_tree_hook_class
        .deploy(@array![mailbox.contract_address.into(), OWNER().try_into().unwrap()]);
    if (res.is_err()) {
        panic(res.unwrap_err());
    }
    let (merkle_tree_hook_addr, _) = res.unwrap();
    let mut spy = spy_events(SpyOn::One(merkle_tree_hook_addr));

    (
        IMerkleTreeHookDispatcher { contract_address: merkle_tree_hook_addr },
        IPostDispatchHookDispatcher { contract_address: merkle_tree_hook_addr },
        spy
    )
}

pub fn setup_mock_fee_hook() -> IPostDispatchHookDispatcher {
    let mock_hook = declare("fee_hook").unwrap();
    let (mock_hook_addr, _) = mock_hook.deploy(@array![]).unwrap();
    IPostDispatchHookDispatcher { contract_address: mock_hook_addr }
}

pub fn setup_mock_hook() -> IPostDispatchHookDispatcher {
    let mock_hook = declare("hook").unwrap();
    let (mock_hook_addr, _) = mock_hook.deploy(@array![]).unwrap();
    IPostDispatchHookDispatcher { contract_address: mock_hook_addr }
}

pub fn setup_noop_ism() -> IInterchainSecurityModuleDispatcher {
    let noop_ism = declare("noop_ism").unwrap();
    let (noop_ism_addr, _) = noop_ism.deploy(@array![]).unwrap();
    IInterchainSecurityModuleDispatcher { contract_address: noop_ism_addr }
}


pub fn setup_pausable_ism() -> (IInterchainSecurityModuleDispatcher, IPausableIsmDispatcher) {
    let pausable_ism = declare("pausable_ism").unwrap();
    let (pausable_ism_addr, _) = pausable_ism.deploy(@array![OWNER().try_into().unwrap()]).unwrap();
    (
        IInterchainSecurityModuleDispatcher { contract_address: pausable_ism_addr },
        IPausableIsmDispatcher { contract_address: pausable_ism_addr }
    )
}

pub fn setup_trusted_relayer_ism() -> IInterchainSecurityModuleDispatcher {
    let (mailbox, _, _, _) = setup_mailbox(DESTINATION_MAILBOX(), Option::None, Option::None);
    let trusted_relayer_ism = declare("trusted_relayer_ism").unwrap();
    let (trusted_relayer_ism_addr, _) = trusted_relayer_ism
        .deploy(@array![mailbox.contract_address.into(), OWNER().try_into().unwrap()])
        .unwrap();
    IInterchainSecurityModuleDispatcher { contract_address: trusted_relayer_ism_addr }
}

pub fn build_messageid_metadata(origin_merkle_tree_hook: u256, root: u256, index: u32) -> Bytes {
    let y_parity = 0x01;
    let (_, _, signatures) = get_message_and_signature();
    let mut metadata = BytesTrait::new_empty();
    metadata.append_u256(origin_merkle_tree_hook);
    metadata.append_u256(root);
    metadata.append_u32(index);
    let mut cur_idx = 0;
    loop {
        if (cur_idx == signatures.len()) {
            break ();
        }
        metadata.append_u256(*signatures.at(cur_idx).r);
        metadata.append_u256(*signatures.at(cur_idx).s);
        metadata.append_u8(y_parity);
        cur_idx += 1;
    };
    metadata
}

pub fn build_fake_messageid_metadata(
    origin_merkle_tree_hook: u256, root: u256, index: u32
) -> Bytes {
    let y_parity = 0x01;
    let (_, _, signatures) = get_message_and_signature();
    let mut metadata = BytesTrait::new_empty();
    metadata.append_u256(origin_merkle_tree_hook);
    metadata.append_u256(root);
    metadata.append_u32(index);
    let mut cur_idx = 0;
    loop {
        if (cur_idx == signatures.len()) {
            break ();
        }
        metadata.append_u256(*signatures.at(0).r);
        metadata.append_u256(*signatures.at(0).s);
        metadata.append_u8(y_parity);
        cur_idx += 1;
    };
    metadata
}


// Configuration from the main cairo repo: https://github.com/starkware-libs/cairo/blob/main/corelib/src/test/secp256k1_test.cairo
pub fn get_message_and_signature() -> (u256, Array<felt252>, Array<EthSignature>) {
    let msg_hash = 0xD2B30308834E6E76F50891F0B45E742BE4F4A163BAF697B465DD14C968777AD0;
    let validators_array: Array<felt252> = array![
        0xfa3ed5df8369fb40e75978937607b6f0c0e04fb8.try_into().unwrap(),
        0x2f7008b31a614685a1d24a684827cf05f15dc17a.try_into().unwrap(),
        0x108e9c0c2a24c02d70b224ee9dd97136cdc1e072.try_into().unwrap(),
        0x7851fee3ec28606dfb18041396876524e8fa6256.try_into().unwrap(),
        0xaef2f8fa001982939416fd49e6e533e9fba65a1b.try_into().unwrap(),
    ];
    let signatures = array![
        EthSignature {
            r: 0x83db08d4e1590714aef8600f5f1e3c967ab6a3b9f93bb4242de0306510e688ea,
            s: 0x0af5d1d51ea7e51a291789ff4866a1e36bc4134d956870799380d2d71f5dbf3d,
        },
        EthSignature {
            r: 0xf81a5dd3f871ad2d27a3b538e73663d723f8263fb3d289514346d43d000175f5,
            s: 0x083df770623e9ae52a7bb154473961e24664bb003bdfdba6100fb5e540875ce1,
        },
        EthSignature {
            r: 0x76b194f951f94492ca582dab63dc413b9ac1ca9992c22bc2186439e9ab8fdd3c,
            s: 0x62a6a6f402edaa53e9bdc715070a61edb0d98d4e14e182f60bdd4ae932b40b29,
        },
        EthSignature {
            r: 0x35932eefd85897d868aaacd4ba7aee81a2384e42ba062133f6d37fdfebf94ad4,
            s: 0x78cce49db96ee27c3f461800388ac95101476605baa64a194b7dd4d56d2d4a4d,
        },
        EthSignature {
            r: 0x6b38d4353d69396e91c57542254348d16459d448ab887574e9476a6ff76d49a1,
            s: 0x3527627295bde423d7d799afef22affac4f00c70a5b651ad14c8879aeb9b6e03,
        }
    ];

    (msg_hash, validators_array, signatures)
}


pub fn build_merkle_metadata(
    origin_merkle_tree_hook: u256, message_index: u32, signed_index: u32, signed_message_id: u256
) -> Bytes {
    let proof = TEST_PROOF();
    let y_parity = 0x01;
    let (_, _, signatures) = get_merkle_message_and_signature();
    let mut metadata = BytesTrait::new_empty();
    metadata.append_u256(origin_merkle_tree_hook);
    metadata.append_u32(message_index);
    metadata.append_u256(signed_message_id);
    let mut cur_idx = 0;
    loop {
        if (cur_idx == MERKLE_PROOF_ITERATION) {
            break ();
        }
        metadata.append_u256(*proof.at(cur_idx));
        cur_idx += 1;
    };
    metadata.append_u32(signed_index);
    cur_idx = 0;
    loop {
        if (cur_idx == signatures.len()) {
            break ();
        }
        metadata.append_u256(*signatures.at(cur_idx).r);
        metadata.append_u256(*signatures.at(cur_idx).s);
        metadata.append_u8(y_parity);
        cur_idx += 1;
    };
    metadata
}


pub fn build_fake_merkle_metadata(
    origin_merkle_tree_hook: u256, message_index: u32, signed_index: u32, signed_message_id: u256
) -> Bytes {
    let proof = TEST_PROOF();
    let y_parity = 0x01;
    let (_, _, signatures) = get_merkle_message_and_signature();
    let mut metadata = BytesTrait::new_empty();
    metadata.append_u256(origin_merkle_tree_hook);
    metadata.append_u32(message_index);
    metadata.append_u256(signed_message_id);
    let mut cur_idx = 0;
    loop {
        if (cur_idx == MERKLE_PROOF_ITERATION) {
            break ();
        }
        metadata.append_u256(*proof.at(cur_idx));
        cur_idx += 1;
    };
    metadata.append_u32(signed_index);
    cur_idx = 0;
    loop {
        if (cur_idx == signatures.len()) {
            break ();
        }
        metadata.append_u256(*signatures.at(0).r);
        metadata.append_u256(*signatures.at(0).s);
        metadata.append_u8(y_parity);
        cur_idx += 1;
    };
    metadata
}


// Configuration from the main cairo repo: https://github.com/starkware-libs/cairo/blob/main/corelib/src/test/secp256k1_test.cairo
pub fn get_merkle_message_and_signature() -> (u256, Array<felt252>, Array<EthSignature>) {
    let msg_hash = 0xC9E505E3C9DDD36638A10238CAD43278311CDF09894EF7EFBE6AFBF510507907;
    let validators_array: Array<felt252> = array![
        0x2614ea33eaf750585f8ae3b59a45b2c800b952ed.try_into().unwrap(),
        0xc69bb3f1bedb35543f1c28c0ff4f6428622068d3.try_into().unwrap(),
        0x7f2c0c840dd8855e0625f1e1ede157d4e09bc9c4.try_into().unwrap(),
        0x6d937801434bbf68eb109d3ab2b103a64afcbac2.try_into().unwrap(),
        0xfe5fb670978ee5c686db8a7180509b5682f9797d.try_into().unwrap(),
    ];
    let signatures = array![
        EthSignature {
            r: 0x83db08d4e1590714aef8600f5f1e3c967ab6a3b9f93bb4242de0306510e688ea,
            s: 0x0af5d1d51ea7e51a291789ff4866a1e36bc4134d956870799380d2d71f5dbf3d,
        },
        EthSignature {
            r: 0xf81a5dd3f871ad2d27a3b538e73663d723f8263fb3d289514346d43d000175f5,
            s: 0x083df770623e9ae52a7bb154473961e24664bb003bdfdba6100fb5e540875ce1,
        },
        EthSignature {
            r: 0x76b194f951f94492ca582dab63dc413b9ac1ca9992c22bc2186439e9ab8fdd3c,
            s: 0x62a6a6f402edaa53e9bdc715070a61edb0d98d4e14e182f60bdd4ae932b40b29,
        },
        EthSignature {
            r: 0x35932eefd85897d868aaacd4ba7aee81a2384e42ba062133f6d37fdfebf94ad4,
            s: 0x78cce49db96ee27c3f461800388ac95101476605baa64a194b7dd4d56d2d4a4d,
        },
        EthSignature {
            r: 0x6b38d4353d69396e91c57542254348d16459d448ab887574e9476a6ff76d49a1,
            s: 0x3527627295bde423d7d799afef22affac4f00c70a5b651ad14c8879aeb9b6e03,
        }
    ];

    (msg_hash, validators_array, signatures)
}

pub fn setup_mock_token() -> ERC20ABIDispatcher {
    let fee_token_class = declare("mock_fee_token").unwrap();
    let (fee_token_addr, _) = fee_token_class
        .deploy_at(
            @array![
                INITIAL_SUPPLY.low.into(), INITIAL_SUPPLY.high.into(), OWNER().try_into().unwrap()
            ],
            ETH_ADDRESS()
        )
        .unwrap();
    ERC20ABIDispatcher { contract_address: fee_token_addr }
}

pub fn setup_protocol_fee() -> (IProtocolFeeDispatcher, IPostDispatchHookDispatcher) {
    let protocol_fee_class = declare("protocol_fee").unwrap();
    let (protocol_fee_addr, _) = protocol_fee_class
        .deploy(
            @array![
                MAX_PROTOCOL_FEE.low.into(),
                MAX_PROTOCOL_FEE.high.into(),
                PROTOCOL_FEE.low.into(),
                PROTOCOL_FEE.high.into(),
                BENEFICIARY().into(),
                OWNER().try_into().unwrap(),
                ETH_ADDRESS().into()
            ]
        )
        .unwrap();
    (
        IProtocolFeeDispatcher { contract_address: protocol_fee_addr },
        IPostDispatchHookDispatcher { contract_address: protocol_fee_addr }
    )
}
