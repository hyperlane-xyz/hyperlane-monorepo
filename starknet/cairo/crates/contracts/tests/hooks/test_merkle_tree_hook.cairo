use alexandria_bytes::{Bytes, BytesTrait};
use contracts::hooks::merkle_tree_hook::merkle_tree_hook;
use contracts::interfaces::{
    Types, IPostDispatchHookDispatcher, IPostDispatchHookDispatcherTrait, IMerkleTreeHook,
    IMailboxDispatcher, IMailboxDispatcherTrait, IMerkleTreeHookDispatcher,
    IMerkleTreeHookDispatcherTrait
};
use contracts::libs::message::{Message, MessageTrait, HYPERLANE_VERSION};
use contracts::utils::keccak256::{ByteData, HASH_SIZE};
use contracts::utils::utils::U256TryIntoContractAddress;
use merkle_tree_hook::{InternalTrait, treeContractMemberStateTrait, countContractMemberStateTrait};
use openzeppelin::access::ownable::interface::{IOwnableDispatcher, IOwnableDispatcherTrait};
use snforge_std::cheatcodes::events::EventAssertions;
use snforge_std::{start_prank, CheatTarget};
use super::super::setup::{
    setup_merkle_tree_hook, MAILBOX, LOCAL_DOMAIN, VALID_OWNER, VALID_RECIPIENT, DESTINATION_DOMAIN
};

#[test]
fn test_merkle_tree_hook_type() {
    let (_, merkle_tree_hook, _) = setup_merkle_tree_hook();
    assert_eq!(merkle_tree_hook.hook_type(), Types::MERKLE_TREE(()));
}

#[test]
fn test_supports_metadata() {
    let mut metadata = BytesTrait::new_empty();
    let (_, merkle_tree_hook, _) = setup_merkle_tree_hook();
    assert_eq!(merkle_tree_hook.supports_metadata(metadata.clone()), true);
    let variant = 1;
    metadata.append_u16(variant);
    assert_eq!(merkle_tree_hook.supports_metadata(metadata), true);
    metadata = BytesTrait::new_empty();
    metadata.append_u16(variant + 1);
    assert_eq!(merkle_tree_hook.supports_metadata(metadata), false);
}

#[test]
fn test_post_dispatch() {
    let (merkle_tree, post_dispatch_hook, mut spy) = setup_merkle_tree_hook();
    let mailbox = IMailboxDispatcher { contract_address: MAILBOX() };
    let ownable = IOwnableDispatcher { contract_address: MAILBOX() };
    start_prank(CheatTarget::One(ownable.contract_address), VALID_OWNER().try_into().unwrap());
    let id = mailbox
        .dispatch(
            DESTINATION_DOMAIN,
            VALID_RECIPIENT(),
            BytesTrait::new_empty(),
            0,
            Option::None,
            Option::None
        );
    assert(mailbox.get_latest_dispatched_id() == id, 'Dispatch failed');
    let nonce = 0;
    let local_domain = mailbox.get_local_domain();
    let count = merkle_tree.count();
    let mut metadata = BytesTrait::new_empty();
    let variant = 1;
    metadata.append_u16(variant);
    let message = Message {
        version: HYPERLANE_VERSION,
        nonce: nonce,
        origin: local_domain,
        sender: VALID_OWNER(),
        destination: DESTINATION_DOMAIN,
        recipient: VALID_RECIPIENT(),
        body: BytesTrait::new_empty(),
    };
    post_dispatch_hook.post_dispatch(metadata, message, 0);
    let expected_event = merkle_tree_hook::Event::InsertedIntoTree(
        merkle_tree_hook::InsertedIntoTree { id: id, index: count.try_into().unwrap() }
    );
    spy.assert_emitted(@array![(merkle_tree.contract_address, expected_event),]);
    assert_eq!(merkle_tree.count(), count + 1);
}

#[test]
#[should_panic(expected: ('Message not dispatching',))]
fn test_post_dispatch_fails_if_message_not_dispatching() {
    let (_, post_dispatch_hook, _) = setup_merkle_tree_hook();
    let mut metadata = BytesTrait::new_empty();
    let variant = 1;
    metadata.append_u16(variant);
    let message = Message {
        version: HYPERLANE_VERSION,
        nonce: 0_u32,
        origin: 0_u32,
        sender: VALID_OWNER(),
        destination: 0_u32,
        recipient: VALID_RECIPIENT(),
        body: BytesTrait::new_empty(),
    };
    post_dispatch_hook.post_dispatch(metadata, message, 0);
}
#[test]
#[should_panic(expected: ('Invalid metadata variant',))]
fn test_post_dispatch_fails_if_invalid_variant() {
    let (_, post_dispatch_hook, _) = setup_merkle_tree_hook();
    let mut metadata = BytesTrait::new_empty();
    let variant = 2;
    metadata.append_u16(variant);
    let message = MessageTrait::default();
    post_dispatch_hook.post_dispatch(metadata, message, 0);
}

#[test]
fn test_quote_dispatch() {
    let (_, post_dispatch_hook, _) = setup_merkle_tree_hook();
    let mut metadata = BytesTrait::new_empty();
    let variant = 1;
    metadata.append_u16(variant);
    let message = MessageTrait::default();
    assert_eq!(post_dispatch_hook.quote_dispatch(metadata, message), 0);
}

#[test]
#[should_panic(expected: ('Invalid metadata variant',))]
fn test_quote_dispatch_fails_if_invalid_variant() {
    let (_, post_dispatch_hook, _) = setup_merkle_tree_hook();
    let mut metadata = BytesTrait::new_empty();
    let variant = 2;
    metadata.append_u16(variant);
    let message = MessageTrait::default();
    post_dispatch_hook.quote_dispatch(metadata, message);
}

#[test]
fn test_count() {
    let (merkle_tree, _, _) = setup_merkle_tree_hook();
    let count = merkle_tree.count();
    assert_eq!(count, 0);
}


// Test internal functions 

#[test]
fn test_insert_node_into_merkle_tree_hook() {
    let mut state = merkle_tree_hook::contract_state_for_testing();
    assert_eq!(state.count.read(), 0);

    let node_1: u256 = 'node_1'.try_into().unwrap();
    state._insert(ByteData { value: node_1, size: 6 });
    assert_eq!(state.count.read(), 1);
    assert_eq!(state.tree.read(0), ByteData { value: node_1, size: 6 });

    let node_2: u256 = 'node_2'.try_into().unwrap();
    let expected_hash = 0x61a4bcca63b5e8a46da3abe2080f75c16c18467d5838f00b375d9ba4c7c313dd;
    state._insert(ByteData { value: node_2, size: 6 });
    assert_eq!(state.count.read(), 2);
    assert_eq!(state.tree.read(0), ByteData { value: node_1, size: 6 });
    assert_eq!(state.tree.read(1), ByteData { value: expected_hash, size: HASH_SIZE });

    let node_3: u256 = 'node_3'.try_into().unwrap();
    state._insert(ByteData { value: node_3, size: 6 });
    assert_eq!(state.count.read(), 3);
    assert_eq!(state.tree.read(0), ByteData { value: node_3, size: 6 });
    assert_eq!(state.tree.read(1), ByteData { value: expected_hash, size: HASH_SIZE });

    let node_4: u256 = 'node_4'.try_into().unwrap();
    let expected_hash_2 = 0x478b18b26b7d2fd037a6a26f00b4fac6f0039349b52ba7cf9f342117c2da1083;
    state._insert(ByteData { value: node_4, size: 6 });

    assert_eq!(state.count.read(), 4);
    assert_eq!(state.tree.read(0), ByteData { value: node_3, size: 6 });
    assert_eq!(state.tree.read(1), ByteData { value: expected_hash, size: HASH_SIZE });
    assert_eq!(state.tree.read(2), ByteData { value: expected_hash_2, size: HASH_SIZE });
    let mut expected_result = array![
        ByteData { value: node_3, size: 6 },
        ByteData { value: expected_hash, size: HASH_SIZE },
        ByteData { value: expected_hash_2, size: HASH_SIZE },
    ];
    let mut cur_idx = 0;
    loop {
        if (cur_idx >= merkle_tree_hook::TREE_DEPTH - 3) {
            break;
        }
        expected_result.append(ByteData { value: 0, size: 0 });
        cur_idx += 1;
    };
    assert(state._build_tree() == expected_result, 'build tree failed');
    assert(state._root() != 0, 'root computation failed');
    let (root, count) = state.latest_checkpoint();
    assert_eq!(root, state._root());
    assert_eq!(count, 3);
}

