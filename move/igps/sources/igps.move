module hp_igps::igps {

  use std::signer;
  use aptos_framework::coin::Self;
  use aptos_framework::aptos_coin::AptosCoin;
  use aptos_framework::account;
  use aptos_framework::event::{Self, EventHandle}; 
  use aptos_framework::block;
  use aptos_framework::transaction_context;

  use hp_igps::gas_oracle::Self;
  use hp_igps::events::{ Self, GasPaymentEvent, SetBeneficiaryEvent };

  //
  // Consts
  //
  const TOKEN_EXCHANGE_RATE_SCALE: u256 = 10_000_000_000;

  //
  // Errors
  //
  const ERROR_INVALID_OWNER: u64 = 1;
  const ERROR_CONFIG_LENGTH_MISMATCH: u64 = 2;
  const ERROR_INSUFFICIENT_INTERCHAIN_GAS: u64 = 3;
  const ERROR_INVALID_BENEFICIARY: u64 = 4;

  /// Resource struct which holds contract state
  struct IgpState has key {
    owner_address: address,
    beneficiary: address,
    gas_payment_events: EventHandle<GasPaymentEvent>,
    set_beneficiary_events: EventHandle<SetBeneficiaryEvent>,
  }

  /// Constructor
  fun init_module(account: &signer) {
    let account_address = signer::address_of(account);
    move_to<IgpState>(account, IgpState {
      owner_address: account_address,
      beneficiary: account_address,
      gas_payment_events: account::new_event_handle<GasPaymentEvent>(account),
      set_beneficiary_events: account::new_event_handle<SetBeneficiaryEvent>(account)
    });
  }

  /// Deposits a payment for the relaying of a message
  /// to its destination chain.
  public entry fun pay_for_gas(
    account: &signer,
    message_id: vector<u8>,
    dest_domain: u32,
    gas_amount: u256
  ) acquires IgpState {
    let state = borrow_global_mut<IgpState>(@hp_igps);
    let account_address = signer::address_of(account);

    // calculate interchain gas amount
    let required_amount = (quote_gas_payment(dest_domain, gas_amount) as u64);

    // check account's balance if it is enough to pay interchain gas
    assert!(coin::balance<AptosCoin>(account_address) > required_amount, ERROR_INSUFFICIENT_INTERCHAIN_GAS);
    
    // send gas payment to beneficiary
    let coin = coin::withdraw<AptosCoin>(account, required_amount);
    coin::deposit<AptosCoin>(state.beneficiary, coin);

    // emit GasPayment event
    event::emit_event<GasPaymentEvent>(
      &mut state.gas_payment_events,
      events::new_gas_payment_event(
        message_id,
        gas_amount,
        required_amount,
        block::get_current_block_height(),
        transaction_context::get_transaction_hash(),
      )
    );
  }

  /// Admin Function to set `Beneficiary` account
  public entry fun set_beneficiary(
    account: &signer,
    beneficiary: address
  ) acquires IgpState {
    assert_owner_address(signer::address_of(account));
    let state = borrow_global_mut<IgpState>(@hp_igps);
    state.beneficiary = beneficiary;

    // emit SetBeneficiaryEvent
    event::emit_event<SetBeneficiaryEvent>(
      &mut state.set_beneficiary_events,
      events::new_set_beneficiary_event(beneficiary)
    );
  }

  // Assert Functions
  /// Check Beneficiary
  inline fun assert_beneficiary_address(account_address: address) acquires IgpState {
    assert!(borrow_global<IgpState>(@hp_igps).beneficiary == account_address, ERROR_INVALID_BENEFICIARY);
  }

  /// Check owner
  inline fun assert_owner_address(account_address: address) acquires IgpState {
    assert!(borrow_global<IgpState>(@hp_igps).owner_address == account_address, ERROR_INVALID_OWNER);
  }

  #[view]
  /// Quotes the amount of native tokens to pay for interchain gas.
  public fun quote_gas_payment(dest_domain: u32, gas_amount: u256): u256 {
    let (token_exchange_rate, gas_price) = gas_oracle::get_exchange_rate_and_gas_price(dest_domain);
    let dest_gas_cost = gas_amount * (gas_price as u256);
    (dest_gas_cost * (token_exchange_rate as u256)) / TOKEN_EXCHANGE_RATE_SCALE
  }

  #[view]
  /// Get token exchange rate and gas price from specific gas oracle
  public fun get_exchange_rate_and_gas_price(remote_domain: u32): (u128, u128) {
    gas_oracle::get_exchange_rate_and_gas_price(remote_domain)
  }

  #[test_only]
  public fun init_for_test(account: &signer) {
    init_module(account);
  }
}