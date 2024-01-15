module hp_isms::multisig_ism {
  use std::vector;
  use sui::clock::{Self, Clock};
  use sui::coin::{Self, Coin};
  use sui::balance::{Self, Balance};
  use sui::object::{Self, ID, UID};
  use sui::transfer;
  use sui::tx_context::{Self, TxContext};
  use sui::pay;
  use sui::event;
  use sui::vec_map::{Self, VecMap};

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

  /// Admin Capability
  struct AdminCap has key, store {
      id: UID,
  }
  
  struct ValidatorsAndThreshold has store {
    validators: vector<address>,
    threshold: u64,
  }

  struct ISM has store, key {
    id: UID,
    // Mapping (Domain => ValidatorsAndThreshold)
    validators_per_domain: VecMap<u32, ValidatorsAndThreshold>,
  }

  /// Constructor - initialize state
  fun init(ctx: &mut TxContext) {
    let sender_address = tx_context::sender(ctx);
    transfer::transfer(AdminCap { id: object::new(ctx) }, sender_address);
    transfer::share_object(ISM {
      id: object::new(ctx),
      validators_per_domain: vec_map::empty<u32, ValidatorsAndThreshold>(),
    });
  }

  /// Enrolls multiple validators into a validator set.
  /// And sets threshold
  public entry fun set_validators_and_threshold(
    _admin_cap: &AdminCap,
    ism: &mut ISM,
    validators: vector<address>,
    threshold: u64,
    origin_domain: u32,
    ctx: &mut TxContext
  ) {
    
    let sender_address = tx_context::sender(ctx);
    // check threshold
    assert!(threshold > 0 && threshold <= vector::length(&validators), ERROR_INVALID_THRESHOLD);

    if (!vec_map::contains(&ism.validators_per_domain, &origin_domain)) {
      vec_map::insert(&mut ism.validators_per_domain, origin_domain, ValidatorsAndThreshold {
        validators: validators,
        threshold
      });
    } else {
      let validator_set = vec_map::get_mut(&mut ism.validators_per_domain, &origin_domain);
      validator_set.validators = validators;
      validator_set.threshold = threshold;
    };
  }

  /// Transfer ownership of multisig_ism contract
  entry fun transfer_ownership(
    admin_cap: AdminCap,
    new_owner: address,
    ctx: &mut TxContext
  ) {
    transfer::public_transfer(admin_cap, new_owner);
  }

  /// Requires that m-of-n validators verify a merkle root, 
  /// and verifies a merkle proof of `message` against that root.
  public fun verify(
    ism: &ISM,
    metadata: &vector<u8>,
    message: &vector<u8>,
  ): bool {

    let origin_mailbox = ism_metadata::origin_mailbox(metadata);
    let origin_domain = msg_utils::origin_domain(message);

    let merkle_root = ism_metadata::merkle_root(metadata);
    let merkle_index = ism_metadata::merkle_index(metadata);
    let signed_digest_bytes = utils::eth_signed_message_hash(&utils::ism_checkpoint_hash(
      origin_mailbox,
      origin_domain,
      merkle_root,
      msg_utils::nonce(message),//merkle_index,//msg_utils::nonce(message),
      msg_utils::id(message)
    ));

    let domain_validators = vec_map::get(&ism.validators_per_domain, &origin_domain);
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

      while (validator_index < validator_count && 
        !utils::compare_bytes_and_address(
          &signer_address, 
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
    ism: &ISM,
    origin_domain: u32
  ): (vector<address>, u64) {
    if (!vec_map::contains(&ism.validators_per_domain, &origin_domain)) {
      return (vector[], 0)
    };
    let domain_validators = vec_map::get(&ism.validators_per_domain, &origin_domain);
    (domain_validators.validators, domain_validators.threshold)
  }

  #[test_only]
  public fun init_for_test(ctx: &mut TxContext) {
    init(ctx);
  }
}