module hp_isms::multisig_ism {
  use std::signer;
  use std::vector;
  use std::option;
  use aptos_std::simple_map::{Self, SimpleMap};

  use hp_library::ism_metadata;
  use hp_library::utils;
  use hp_library::msg_utils;

  //
  // Constants
  //
  const MAILBOX_STATE_SEED: vector<u8> = b"MAILBOX_STATE_SEED";
  const MODULE_TYPE: u64 = 5; // MESSAGE_ID_MULTISIG
  
  //
  // Errors
  //
  const ERROR_INVALID_OWNER: u64 = 1;
  const ERROR_THRESHOLD_NOT_MET: u64 = 2;
  const ERROR_INVALID_THRESHOLD: u64 = 33;

  struct ValidatorsAndThreshold has store {
    validators: vector<address>,
    threshold: u64,
  }

  struct ISM has store, key {
    // Mapping (Domain => ValidatorsAndThreshold)
    validators_per_domain: SimpleMap<u32, ValidatorsAndThreshold>,
    owner: address
  }

  /// Constructor - initialize state
  fun init_module(account: &signer) {
    move_to<ISM>(account, ISM {
      validators_per_domain: simple_map::create<u32, ValidatorsAndThreshold>(),
      owner: signer::address_of(account)
    });
  }

  /// Enrolls multiple validators into a validator set.
  /// And sets threshold
  public entry fun set_validators_and_threshold(
    account: &signer,
    validators: vector<address>,
    threshold: u64,
    origin_domain: u32
  ) acquires ISM {
    let state = borrow_global_mut<ISM>(@hp_isms);
    
    // only owner can set
    assert!(state.owner == signer::address_of(account), ERROR_INVALID_OWNER);
    // check threshold
    assert!(threshold > 0 && threshold <= vector::length(&validators), ERROR_INVALID_THRESHOLD);

    if (!simple_map::contains_key(&state.validators_per_domain, &origin_domain)) {
      simple_map::add(&mut state.validators_per_domain, origin_domain, ValidatorsAndThreshold {
        validators: validators,
        threshold
      });
    } else {
      let validator_set = simple_map::borrow_mut(&mut state.validators_per_domain, &origin_domain);
      validator_set.validators = validators;
      validator_set.threshold = threshold;
    };
  }

  /// Transfer ownership of multisig_ism contract
  entry fun transfer_ownership(
    account: &signer,
    new_owner: address
  ) acquires ISM {
    let state = borrow_global_mut<ISM>(@hp_isms);
    assert!(state.owner == signer::address_of(account), ERROR_INVALID_OWNER);
    state.owner = new_owner;
  }

  /// Requires that m-of-n validators verify a merkle root, 
  /// and verifies a merkle proof of `message` against that root.
  public fun verify(
    metadata: &vector<u8>,
    message: &vector<u8>,
  ): bool acquires ISM {
    let state = borrow_global<ISM>(@hp_isms);

    let origin_mailbox = ism_metadata::origin_mailbox(metadata);
    let origin_domain = msg_utils::origin_domain(message);

    let merkle_root = ism_metadata::merkle_root(metadata);
    let signed_digest_bytes = utils::eth_signed_message_hash(&utils::ism_checkpoint_hash(
      origin_mailbox,
      origin_domain,
      merkle_root,
      msg_utils::nonce(message),
      msg_utils::id(message)
    ));

    
    let domain_validators = simple_map::borrow(&state.validators_per_domain, &origin_domain);
    let validator_count = vector::length(&domain_validators.validators);
    let validator_index = 0;

    let i = 0;
    let verify_result = true;
    // Assumes that signatures are ordered by validator
    while ( i < domain_validators.threshold ) {
      let validator_signature = ism_metadata::signature_at(metadata, i);
      let signer_address = utils::secp256k1_recover_ethereum_address(
        &signed_digest_bytes,
        &validator_signature
      );

      // address recover failed
      if (option::is_none(&signer_address)) {
        verify_result = false;
        break
      };

      while (validator_index < validator_count && 
        !utils::compare_bytes_and_address(
          option::borrow(&signer_address), 
          vector::borrow(&domain_validators.validators, validator_index)
        )
      ) {
          validator_index = validator_index + 1;
      };

      if (validator_index >= validator_count) {
        verify_result = false;
        break
      };
      
      validator_index = validator_index + 1;
      i = i + 1;
    };
    verify_result
  }

  #[view]
  /// Return ISM Module Type - MESSAGE_ID_MULTISIG
  public fun get_module_type(): u64 {
    MODULE_TYPE
  }

  #[view]
  /// Returns the set of validators responsible for verifying message from `origin_domain`
  /// And returns number of signatures required
  public fun validators_and_threshold(
    origin_domain: u32
  ): (vector<address>, u64) acquires ISM {
    let state = borrow_global<ISM>(@hp_isms);
    if (!simple_map::contains_key(&state.validators_per_domain, &origin_domain)) {
      return (vector[], 0)
    };
    let domain_validators = simple_map::borrow(&state.validators_per_domain, &origin_domain);
    (domain_validators.validators, domain_validators.threshold)
  }

  #[test_only]
  public fun init_for_test(account: &signer) {
    init_module(account);
  }
}