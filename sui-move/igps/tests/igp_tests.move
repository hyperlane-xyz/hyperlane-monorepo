#[test_only]
module hp_igps::igp_tests {
  use std::vector;

  use sui::tx_context::{Self, TxContext};
  use sui::test_scenario::{Self, Scenario, next_tx, ctx};
  use hp_library::test_utils::{Self, scenario};

  use hp_igps::igps;
  use hp_igps::gas_oracle;

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const TOKEN_EXCHANGE_RATE_SCALE: u256 = 10_000_000_000;

  public fun init_igps_for_test(ctx: &mut TxContext) {
    // init `gas_oracle` module with contract account
    gas_oracle::init_for_test(ctx);
    // init `igps` module with contract account
    igps::init_for_test(ctx);
  }

  #[test]
  fun set_remote_gas_data_test() {
    let admin = @0xA;
    let scenario_val = scenario();
    let scenario = &mut scenario_val;


    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      init_igps_for_test(ctx);
    };

    // set exchange rate: 1 BNB = 50 APT
    let token_exchange_rate = 500_000_000_000; 
    // bsc network gas price
    let gas_price = 100000000000;
    
    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      let admin_cap = test_scenario::take_from_address<gas_oracle::AdminCap>(scenario, admin);
      let oracle_state = test_scenario::take_shared<gas_oracle::OracleState>(scenario);
      let ctx = test_scenario::ctx(scenario);
      gas_oracle::set_remote_gas_data(
        &admin_cap,
        &mut oracle_state,
        BSC_TESTNET_DOMAIN,
        token_exchange_rate,
        gas_price
      );
      
      test_scenario::return_to_address(admin, admin_cap);
      test_scenario::return_shared(oracle_state);
    };

    next_tx(scenario, admin);
    {
      // test `get_exchange_rate_and_gas_price` function
      let oracle_state = test_scenario::take_shared<gas_oracle::OracleState>(scenario);
      let (
        expected_token_exchange_rate,
        expected_gas_price
      ) = igps::get_exchange_rate_and_gas_price(&oracle_state, BSC_TESTNET_DOMAIN);

      assert!(expected_token_exchange_rate == token_exchange_rate && expected_gas_price == gas_price, 0);
      test_scenario::return_shared(oracle_state);
    };

    test_scenario::end(scenario_val);
  }
/*
  #[test(aptos_framework = @0x1, hp_igps=@hp_igps, alice = @0xa11ce, bob = @0xb0b)]
  fun pay_gas_and_beneficiary_test(aptos_framework: signer, hp_igps: signer, alice: signer, bob: signer) {
    test_utils::setup(&aptos_framework, &hp_igps, vector[signer::address_of(&alice), @0xb0b]);

    init_igps_for_test(&hp_igps);

    // set exchange rate: 1 BNB = 50 APT
    let token_exchange_rate = 500_000_000_000; 
    // bsc network gas price
    let gas_price = 1000;

    // set gas data
    gas_oracle::set_remote_gas_data(
      &hp_igps,
      BSC_TESTNET_DOMAIN,
      token_exchange_rate,
      gas_price
    );
    
    // amount of gas
    let gas_amount = 500000;
    let expected_gas_payment = igps::quote_gas_payment(BSC_TESTNET_DOMAIN, gas_amount);
    assert!(expected_gas_payment == 1000 * 500000 * 50, 0);

    // set beneficiary
    igps::set_beneficiary(&hp_igps, @0xb0b);

    // try to pay for gas
    let bob_aptos_amt = coin::balance<AptosCoin>(@0xb0b);
    igps::pay_for_gas(&alice, vector[0], BSC_TESTNET_DOMAIN, gas_amount);

    // check beneficiary coin amount
    assert!(coin::balance<AptosCoin>(@0xb0b) == bob_aptos_amt + (expected_gas_payment as u64), 1);
  }
  */

}