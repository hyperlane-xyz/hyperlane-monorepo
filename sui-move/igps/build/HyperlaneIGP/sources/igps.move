module hp_igps::igps {
  use sui::sui::{SUI};
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

  use hp_igps::gas_oracle::{Self, OracleState};

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

  //
  // Events
  //
  struct GasPaymentEvent has store, drop, copy {
    dest_domain: u32,
    message_id: vector<u8>,
    gas_amount: u256,
    required_payment: u64,
    // block_height: u64,
    // transaction_hash: vector<u8>,
  }

  struct SetBeneficiaryEvent has store, drop, copy {
    beneficiary: address
  }

  /// Resource struct which holds contract state
  struct IgpState has key {
    id: UID,
    beneficiary: address,
  }

  /// Admin Capability
  struct AdminCap has key, store {
      id: UID,
  }

  /// Constructor
  fun init(ctx: &mut TxContext) {
    let sender_address = tx_context::sender(ctx);
    transfer::transfer(AdminCap { id: object::new(ctx) }, sender_address);
    transfer::share_object(IgpState {
      id: object::new(ctx),
      beneficiary: sender_address
    });
  }

  /// Deposits a payment for the relaying of a message
  /// to its destination chain.
  public entry fun pay_for_gas(
    igp: &IgpState,
    oracle_state: &OracleState,
    token: Coin<SUI>,
    message_id: vector<u8>,
    dest_domain: u32,
    gas_amount: u256,
    ctx: &mut TxContext
  ) acquires IgpState {
    let sender_address = tx_context::sender(ctx);

    // calculate interchain gas amount
    let required_amount = (quote_gas_payment(oracle_state, dest_domain, gas_amount) as u64);

    // check account's balance if it is enough to pay interchain gas
    
    assert!(coin::value(&token) > required_amount, ERROR_INSUFFICIENT_INTERCHAIN_GAS);
    
    // send gas payment to beneficiary
    let coins_in = coin::split(&mut token, required_amount, ctx);
    return_remaining_coin(token, ctx);

    transfer::public_transfer(coins_in, igp.beneficiary);

    // emit GasPayment event
    event::emit(GasPaymentEvent {
      dest_domain,
      message_id,
      gas_amount,
      required_payment: required_amount
    });
  }

  /// Admin Function to set `Beneficiary` account
  public entry fun set_beneficiary(
    igp: &mut IgpState,
    _admin_cap: &AdminCap,
    beneficiary: address,
    ctx: &mut TxContext
  ) acquires IgpState {

    igp.beneficiary = beneficiary;

    // emit SetBeneficiaryEvent
    event::emit(SetBeneficiaryEvent {
      beneficiary
    });
  }

  
  fun return_remaining_coin(
      coin: Coin<SUI>,
      ctx: &mut TxContext,
  ) {
      if (coin::value(&coin) == 0) {
          coin::destroy_zero(coin);
      } else {
          transfer::public_transfer(coin, tx_context::sender(ctx));
      };
  }


  #[view]
  /// Quotes the amount of native tokens to pay for interchain gas.
  public fun quote_gas_payment(oracle_state: &OracleState, dest_domain: u32, gas_amount: u256): u256 {
    let (token_exchange_rate, gas_price) = gas_oracle::get_exchange_rate_and_gas_price(oracle_state, dest_domain);
    let dest_gas_cost = gas_amount * (gas_price as u256);
    (dest_gas_cost * (token_exchange_rate as u256)) / TOKEN_EXCHANGE_RATE_SCALE
  }

  #[view]
  /// Get token exchange rate and gas price from specific gas oracle
  public fun get_exchange_rate_and_gas_price(oracle_state: &OracleState, remote_domain: u32): (u128, u128) {
    gas_oracle::get_exchange_rate_and_gas_price(oracle_state, remote_domain)
  }

  #[test_only]
  public fun init_for_test(ctx: &mut TxContext) {
    init(ctx)
  }
}