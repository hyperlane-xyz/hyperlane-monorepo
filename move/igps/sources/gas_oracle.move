module hp_igps::gas_oracle {

  use std::vector::Self;
  use std::signer;
  use aptos_std::simple_map::{Self, SimpleMap};
  use aptos_framework::account;
  use aptos_framework::event::{Self, EventHandle}; 
  use hp_igps::events::{ Self, SetGasDataEvent };

  //
  // Errors
  //
  const ERROR_INVALID_OWNER: u64 = 1;
  const ERROR_CONFIG_LENGTH_MISMATCH: u64 = 2;

  //
  // Resources
  //

  /// Holds Gas information per domain
  struct GasData has store {
    token_exchange_rate: u128,
    gas_price: u128
  }

  /// Holds state of oracle contract on aptos
  struct OracleState has key {
    owner_address: address,
    // Mapping (Domain => GasData)
    gas_data_set: SimpleMap<u32, GasData>,
    // event handlers
    set_gas_data_events: EventHandle<SetGasDataEvent>,
  }

  /// Constructor
  fun init_module(account: &signer) {
    let account_address = signer::address_of(account);
    move_to<OracleState>(account, OracleState {
      owner_address: account_address,
      gas_data_set: simple_map::create<u32, GasData>(),
      set_gas_data_events: account::new_event_handle<SetGasDataEvent>(account)
    });
  }

  //
  // Entry Functions (OnlyAdmin)
  //

  /// Sets the remote gas data for many remotes at a time.
  public entry fun set_remote_gas_data_list(
    account: &signer,
    remote_domains: vector<u32>,
    token_exchange_rates: vector<u128>,
    gas_prices: vector<u128>,
  ) acquires OracleState {
    assert_owner_address(signer::address_of(account));
    let state = borrow_global_mut<OracleState>(@hp_igps);
    // compare lengths
    assert_configs_lengths_should_be_same(&remote_domains, &token_exchange_rates, &gas_prices);
    // enumerating config values to set one by one
    let len = vector::length(&remote_domains);
    let i = 0;
    while(i < len) {
      let domain: u32 = *vector::borrow(&remote_domains, i);
      let token_exchange_rate: u128 = *vector::borrow(&token_exchange_rates, i);
      let gas_price: u128 = *vector::borrow(&gas_prices, i);
      internal_set_gas_data(state, domain, token_exchange_rate, gas_price);
      i = i + 1;
    }
  }
  
  /// Sets the remote gas data using the values in parameters.
  public entry fun set_remote_gas_data(
    account: &signer,
    remote_domain: u32,
    token_exchange_rate: u128,
    gas_price: u128
  ) acquires OracleState {
    assert_owner_address(signer::address_of(account));
    let state = borrow_global_mut<OracleState>(@hp_igps);
    internal_set_gas_data(state, remote_domain, token_exchange_rate, gas_price);
  }

  /// internal function to set gas data
  fun internal_set_gas_data(
    state: &mut OracleState,
    remote_domain: u32,
    token_exchange_rate: u128,
    gas_price: u128
  ) {
    // insert new gas data or update old update
    if (!simple_map::contains_key(&state.gas_data_set, &remote_domain)) {
      simple_map::add(&mut state.gas_data_set, remote_domain, GasData {
        token_exchange_rate,
        gas_price
      });
    } else {
      let gas_data = simple_map::borrow_mut(&mut state.gas_data_set, &remote_domain);
      gas_data.token_exchange_rate = token_exchange_rate;
      gas_data.gas_price = gas_price;
    };

    event::emit_event<SetGasDataEvent>(
      &mut state.set_gas_data_events,
      events::new_set_gas_data_event(
        remote_domain,
        token_exchange_rate,
        gas_price
      )
    );
  }

  // Assert Functions
  /// Check vector length of parameters
  inline fun assert_configs_lengths_should_be_same(domains: &vector<u32>, rates: &vector<u128>, prices: &vector<u128>) {
    assert!(
      vector::length(domains) == vector::length(rates)
        && vector::length(domains) == vector::length(prices)
      , ERROR_CONFIG_LENGTH_MISMATCH
    );
  }

  /// Check ownership
  inline fun assert_owner_address(account_address: address) acquires OracleState {
    assert!(borrow_global<OracleState>(@hp_igps).owner_address == account_address, ERROR_INVALID_OWNER);
  }

  #[view]
  /// Returns the stored `token_exchange_rate` and `gas_price` for the `remote_domain`.
  public fun get_exchange_rate_and_gas_price(
    remote_domain: u32
  ): (u128, u128) acquires OracleState {
    let state = borrow_global<OracleState>(@hp_igps);
    if (!simple_map::contains_key(&state.gas_data_set, &remote_domain)) {
      (0, 0)
    } else {
      let gas_data = simple_map::borrow(&state.gas_data_set, &remote_domain);
      (gas_data.token_exchange_rate, gas_data.gas_price)
    }
  }

  #[test_only]
  public fun init_for_test(account: &signer) {
    init_module(account);
  }
}