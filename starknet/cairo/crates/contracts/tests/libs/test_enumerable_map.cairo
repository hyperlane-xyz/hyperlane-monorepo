use contracts::libs::enumerable_map::{EnumerableMapTrait};
use mocks::enumerable_map_holder::{
    IEnumerableMapHolderDispatcher, IEnumerableMapHolderDispatcherTrait
};
use snforge_std::{declare, ContractClassTrait};
use starknet::{ClassHash, ContractAddress};


fn setup() -> IEnumerableMapHolderDispatcher {
    let contract = declare("EnumerableMapHolder").unwrap();
    let (contract_address, _) = contract.deploy(@array![]).unwrap();
    IEnumerableMapHolderDispatcher { contract_address }
}

#[test]
fn test_initialize_empty_map() {
    let contract = setup();
    assert_eq!(contract.do_get_len(), 0, "EnumerableMap is not empty");
}

#[test]
fn test_fuzz_set(key: u32, val: u256) {
    let mut contract = setup();
    assert_eq!(contract.do_get_len(), 0, "EnumerableMap is not empty");
    contract.do_set_key(key, val);
    // check len increased
    assert_eq!(contract.do_get_len(), 1, "EnumerableMap is empty");
    // check value stored in 'values' map correctly and test get method
    assert_eq!(contract.do_get_value(key), val, "Value not stored properly");
    // check value key correctly stored in keys array and test at method
    let (_key, _value) = contract.do_at(0);
    assert_eq!(key, key, "Key mismatch");
    assert_eq!(_value, val, "Value mismatch");
    // check if its been correctly setted in 'positions' mapping
    assert!(contract.do_contains(key), "Key not registered to positions mapping");
}

#[test]
fn test_fuzz_contains(key: u32, val: u256, should_contain: u8) {
    let mut contract = setup();
    let should_contain: bool = should_contain % 2 == 1;
    if should_contain {
        contract.do_set_key(key, val);
    }
    assert_eq!(contract.do_contains(key), should_contain);
}

#[test]
fn test_fuzz_should_remove(key: u32, val: u256) {
    let mut contract = setup();
    contract.do_set_key(key, val);
    // check len increased
    assert_eq!(contract.do_get_len(), 1, "EnumerableMap is empty");
    // check value stored in 'values' map correctly
    assert_eq!(contract.do_get_value(key), val, "Value not stored properly");
    // check value key correctly stored in keys array 
    let (_key, _value) = contract.do_at(0);
    assert_eq!(key, key, "Key mismatch");
    assert_eq!(_value, val, "Value mismatch");
    // check if its been correctly setted in 'positions' mapping
    assert!(contract.do_contains(key), "Key not registered to positions mapping");
    assert!(contract.do_remove(key), "Failed to remove element");
    // check len decreased
    assert_eq!(contract.do_get_len(), 0, "EnumerableMap len not decreased");
    // check if its been correctly removed in 'positions' mapping
    assert!(!contract.do_contains(key), "Key not removed from positions mapping");
}

#[test]
fn test_fuzz_get_keys(
    mut key1: u32, mut key2: u32, mut key3: u32, val1: u256, val2: u256, val3: u256
) {
    if key1 == key2 {
        key2 += 1;
    }
    if key1 == key3 {
        key3 += 1;
    }
    if key2 == key3 {
        key3 += 1;
    }
    let keys_to_add: Span<u32> = array![key1, key2, key3].span();
    let values_to_add: Span<u256> = array![val1, val2, val3].span();
    let mut contract = setup();
    let mut i = 0;
    let len = keys_to_add.len();
    while i < len {
        contract.do_set_key(*keys_to_add.at(i), *values_to_add.at(i));
        i += 1;
    };
    assert_eq!(contract.do_get_len(), len, "Length mismatch");
    let keys = contract.do_get_keys();
    let mut i = 0;
    while i < len {
        assert_eq!(*keys.at(i), *keys_to_add.at(i), "key mismatch");
        i += 1;
    };

    // remove the middle elem and get again
    contract.do_remove(key2);
    assert!(!contract.do_contains(key2), "Key2 not removed from positions mapping");
    let expected_keys: Span<u32> = array![key1, key3].span();
    assert_eq!(contract.do_get_len(), expected_keys.len(), "Length mismatch");

    let keys = contract.do_get_keys();
    let len = keys.len();
    let mut i = 0;
    while i < len {
        assert_eq!(*keys.at(i), *expected_keys.at(i), "key mismatch");
        i += 1;
    };
}
