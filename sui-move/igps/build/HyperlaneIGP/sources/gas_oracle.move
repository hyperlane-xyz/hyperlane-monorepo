module hp_igps::gas_oracle {

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

  //
  // Errors
  //
  const ERROR_INVALID_OWNER: u64 = 1;
  const ERROR_CONFIG_LENGTH_MISMATCH: u64 = 2;

  //
  // Resources
  //

  /// events
  struct SetGasDataEvent has store, drop, copy {
    remote_domain: u32,
    token_exchange_rate: u128,
    gas_price: u128
  }
  
  /// Holds Gas information per domain
  struct GasData has store {
    token_exchange_rate: u128,
    gas_price: u128
  }

  /// Admin Capability
  struct AdminCap has key, store {
      id: UID,
  }
  
  /// Holds state of oracle contract on aptos
  struct OracleState has key {
    id: UID,
    // Mapping (Domain => GasData)
    gas_data_set: VecMap<u32, GasData>,
  }

  /// Constructor
  fun init(ctx: &mut TxContext) {
    let sender_address = tx_context::sender(ctx);
    transfer::transfer(AdminCap { id: object::new(ctx) }, sender_address);
    transfer::share_object(OracleState {
      id: object::new(ctx),
      gas_data_set: vec_map::empty<u32, GasData>(),
    });
  }

  //
  // Entry Functions (OnlyAdmin)
  //

  /// Sets the remote gas data for many remotes at a time.
  public entry fun set_remote_gas_data_list(
    _admin_cap: &AdminCap,
    oracle_state: &mut OracleState,
    remote_domains: vector<u32>,
    token_exchange_rates: vector<u128>,
    gas_prices: vector<u128>,
    ctx: &mut TxContext
  ) {
    // compare lengths
    assert_configs_lengths_should_be_same(&remote_domains, &token_exchange_rates, &gas_prices);
    // enumerating config values to set one by one
    let len = vector::length(&remote_domains);
    let i = 0;
    while(i < len) {
      let domain: u32 = *vector::borrow(&remote_domains, i);
      let token_exchange_rate: u128 = *vector::borrow(&token_exchange_rates, i);
      let gas_price: u128 = *vector::borrow(&gas_prices, i);
      internal_set_gas_data(oracle_state, domain, token_exchange_rate, gas_price);
      i = i + 1;
    }
  }
  
  /// Sets the remote gas data using the values in parameters.
  public entry fun set_remote_gas_data(
    _admin_cap: &AdminCap,
    oracle_state: &mut OracleState,
    remote_domain: u32,
    token_exchange_rate: u128,
    gas_price: u128
  ) acquires OracleState {
    internal_set_gas_data(oracle_state, remote_domain, token_exchange_rate, gas_price);
  }

  /// internal function to set gas data
  fun internal_set_gas_data(
    state: &mut OracleState,
    remote_domain: u32,
    token_exchange_rate: u128,
    gas_price: u128
  ) {
    // insert new gas data or update old update
    if (!vec_map::contains(&state.gas_data_set, &remote_domain)) {
      vec_map::insert(&mut state.gas_data_set, remote_domain, GasData {
        token_exchange_rate,
        gas_price
      });
    } else {
      let gas_data = vec_map::get_mut(&mut state.gas_data_set, &remote_domain);
      gas_data.token_exchange_rate = token_exchange_rate;
      gas_data.gas_price = gas_price;
    };

    event::emit(SetGasDataEvent {
      remote_domain,
      token_exchange_rate,
      gas_price
    });
  }

  // Assert Functions
  /// Check vector length of parameters
  fun assert_configs_lengths_should_be_same(domains: &vector<u32>, rates: &vector<u128>, prices: &vector<u128>) {
    assert!(
      vector::length(domains) == vector::length(rates)
        && vector::length(domains) == vector::length(prices)
      , ERROR_CONFIG_LENGTH_MISMATCH
    );
  }

  #[view]
  /// Returns the stored `token_exchange_rate` and `gas_price` for the `remote_domain`.
  public fun get_exchange_rate_and_gas_price(
    oracle_state: &OracleState,
    remote_domain: u32
  ): (u128, u128) {
    if (!vec_map::contains(&oracle_state.gas_data_set, &remote_domain)) {
      (0, 0)
    } else {
      let gas_data = vec_map::get(&oracle_state.gas_data_set, &remote_domain);
      (gas_data.token_exchange_rate, gas_data.gas_price)
    }
  }

  #[test_only]
  public fun init_for_test(ctx: &mut TxContext) {
    init(ctx)
  }
}