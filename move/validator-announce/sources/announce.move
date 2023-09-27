module hp_validator::validator_announce {

  use std::signer;
  use std::vector;
  use std::bcs;
  use std::option;
  use std::string::{Self, String};
  
  use aptos_std::simple_map::{Self, SimpleMap};

  use aptos_framework::event::{Self, EventHandle};
  use aptos_framework::account;

  use hp_library::utils::{Self, hash_concat};
  use hp_validator::events::{Self, AnnouncementEvent};

  //
  // Constants
  //
  const ERROR_ANNOUNCE_REPLAY: u64 = 0;
  const ERROR_INVALID_SIGNATURE: u64 = 1;
  const ERROR_INVALID_ACCOUNT: u64 = 2;
  const ERROR_INVALID_VALIDATOR_SIGN: u64 = 3;

  //
  // Resources
  //
  struct ValidatorState has key, store {
    mailbox: address,
    domain: u32,
    storage_locations: SimpleMap<address, vector<String>>,
    replay_protection: vector<vector<u8>>,
    validators_list: vector<address>,
    // event handlers
    announcement_events: EventHandle<AnnouncementEvent>,
  }

  fun init_module(account: &signer) {
    move_to<ValidatorState>(account, ValidatorState {
      mailbox: @0x1,
      domain: 0,
      storage_locations: simple_map::create<address, vector<String>>(),
      replay_protection: vector::empty<vector<u8>>(),
      validators_list: vector::empty<address>(),
      announcement_events: account::new_event_handle<AnnouncementEvent>(account)
    });
  }

  public entry fun initialize(account: &signer, mailbox: address, domain: u32) acquires ValidatorState {
    let validator_state = borrow_global_mut<ValidatorState>(@hp_validator);
    assert!(signer::address_of(account) == @hp_validator, ERROR_INVALID_ACCOUNT);
    
    validator_state.mailbox = mailbox;
    validator_state.domain = domain;
  }

  public entry fun announce(
    account: &signer,
    validator: address,
    signature: vector<u8>,
    storage_location: String
  ) acquires ValidatorState {
    let validator_state = borrow_global_mut<ValidatorState>(@hp_validator);

    // Ensure that the same storage metadata isn't being announced
    // multiple times for the same validator.
    let replay_id = hash_concat(
      bcs::to_bytes(&validator), 
      *string::bytes(&storage_location)
    );
    assert!(!vector::contains(&validator_state.replay_protection, &replay_id), ERROR_ANNOUNCE_REPLAY);
    vector::push_back(&mut validator_state.replay_protection, replay_id);

    // Verify that the signature matches the declared validator
    verify_validator_signed_announcement_internal(
      validator_state, 
      validator,
      signature,
      storage_location
    );
    
    // Store the announcement, Update storage locations
    if (!vector::contains(&validator_state.validators_list, &validator)) {
      vector::push_back(&mut validator_state.validators_list, validator);
      simple_map::add(&mut validator_state.storage_locations, validator, vector::empty<String>());
    };
    let locations = simple_map::borrow_mut<address, vector<String>>(
      &mut validator_state.storage_locations,
      &validator
    );
    vector::push_back(locations, storage_location);

    // emit events
    event::emit_event<AnnouncementEvent>(
      &mut validator_state.announcement_events,
      events::new_validator_announce_event(
        validator,
        storage_location
      )
    );
  }

  fun verify_validator_signed_announcement_internal(
    validator_state: &ValidatorState,
    validator: address,
    signature: vector<u8>,
    storage_location: String
  ) {
    let hash_msg = hash_concat(
      utils::announcement_digest(
        validator_state.mailbox,
        validator_state.domain,
      ),
      *string::bytes(&storage_location)
    );

    let announcement_digest = utils::eth_signed_message_hash(&hash_msg);
    let signer_address_result = utils::secp256k1_recover_ethereum_address(
      &announcement_digest,
      &signature
    );

    assert!(option::is_some<vector<u8>>(&signer_address_result), ERROR_INVALID_SIGNATURE);
    let signer_address_bytes = option::extract<vector<u8>>(&mut signer_address_result);

    // TODO: compare `address_bytes` and `address`

    aptos_std::debug::print<vector<u8>>(&signer_address_bytes);
    aptos_std::debug::print<address>(&validator);
    
    assert!(utils::compare_bytes_and_address(&signer_address_bytes, &validator), ERROR_INVALID_VALIDATOR_SIGN);
  }
  

  #[view]
  /// Returns a list of all announced storage locations
  /// @param `_validators` The list of validators to get registrations for
  /// @return A list of registered storage metadata
  public fun get_announced_storage_locations(validator_list: vector<address>): vector<vector<String>> acquires ValidatorState {
    let validator_state = borrow_global<ValidatorState>(@hp_validator);
    let result = vector::empty<vector<String>>();
    let i = 0;
    // loop all validator addresses from parameter
    while (i < vector::length(&validator_list)) {
      let validator = vector::borrow(&validator_list, i);
      // find validator's storage_locations
      if (simple_map::contains_key(&validator_state.storage_locations, validator)) {  
        let storage_locations = simple_map::borrow(&validator_state.storage_locations, validator);
        vector::push_back(&mut result, *storage_locations);
      };
      i = i + 1;
    };
    result
  }

  #[view]
  /// Returns a list of validators that have made announcements
  public fun get_announced_validators(): vector<address> acquires ValidatorState {
    borrow_global<ValidatorState>(@hp_validator).validators_list
  }

  #[test_only]
  use hp_library::test_utils;

  #[test(aptos = @0x1, announce_signer = @hp_validator, bob = @0xb0b)]
  fun verify_signature_test(aptos: signer, announce_signer: signer, bob: signer) acquires ValidatorState {
    let mailbox: address = @0x35231d4c2d8b8adcb5617a638a0c4548684c7c70;
    let domain: u32 = 1;
    let validator: address = @0x4c327ccb881a7542be77500b2833dc84c839e7b7;
    let storage_location: String = string::utf8(b"s3://hyperlane-mainnet2-ethereum-validator-0/us-east-1");
    // init envs
    test_utils::setup(&aptos, &announce_signer, vector[]);
    init_module(&announce_signer);
    initialize(&announce_signer, mailbox, domain);

    let signature = x"20ac937917284eaa3d67287278fc51875874241fffab5eb5fd8ae899a7074c5679be15f0bdb5b4f7594cefc5cba17df59b68ba3c55836053a23307db5a95610d1b";
    let validator_state = borrow_global_mut<ValidatorState>(@hp_validator);
    verify_validator_signed_announcement_internal(
      validator_state,
      validator,
      signature,
      storage_location
    );

    announce(
      &bob,
      validator,
      signature,
      storage_location
    );
    
    assert!(get_announced_validators() == vector[validator], 1);
    assert!(get_announced_storage_locations(vector[validator]) == vector[vector[storage_location]], 2);
  }

  #[test(aptos = @0x1, announce_signer = @hp_validator, bob = @0xb0b)]
  fun announce_test(aptos: signer, announce_signer: signer, bob: signer) acquires ValidatorState {
    let mailbox: address = @0x476307c25c54b76b331a4e3422ae293ada422f5455efed1553cf4de1222a108f;
    let domain: u32 = 14411;
    let validator: address = @0x598264ff31f198f6071226b2b7e9ce360163accd;
    let storage_location: String = string::utf8(b"file:///tmp/hyperlane-validator-signatures-APTOSLOCALNET1-1");
    // init envs
    test_utils::setup(&aptos, &announce_signer, vector[]);
    init_module(&announce_signer);
    initialize(&announce_signer, mailbox, domain);

    let signature = x"d512c8e5c2861f33c909a72369155518e5388ff2a707b25b62ad72db78eec65f648e65313cda5a5144e787102ae1b801ea8720960f737ddc8020e7bdb6608fff1c";
    let validator_state = borrow_global_mut<ValidatorState>(@hp_validator);
    verify_validator_signed_announcement_internal(
      validator_state,
      validator,
      signature,
      storage_location
    );

    announce(
      &bob,
      validator,
      signature,
      storage_location
    );
    
    assert!(get_announced_validators() == vector[validator], 1);
    assert!(get_announced_storage_locations(vector[validator]) == vector[vector[storage_location]], 2);
  }

  
}