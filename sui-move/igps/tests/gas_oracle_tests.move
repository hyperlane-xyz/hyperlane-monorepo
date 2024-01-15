#[test_only]
module hp_igps::gas_oracle_tests {
  use std::vector;

  use sui::test_scenario::{Self, Scenario, next_tx, ctx};
  use hp_igps::gas_oracle;
  use hp_library::test_utils::{Self, scenario};

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const TOKEN_EXCHANGE_RATE_SCALE: u256 = 10_000_000_000;

  #[test]
  fun set_remote_gas_data_test() {
    let admin = @0xA;
    let scenario_val = scenario();
    let scenario = &mut scenario_val;

    // init module with contract account
    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      gas_oracle::init_for_test(ctx);
    };
  
    // set exchange rate: 1 BNB = 50 APT
    let token_exchange_rate = 500_000_000_000; 
    // bsc network gas price
    let gas_price = 100000000000;
    
    next_tx(scenario, admin);

    {
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
      
      // test `get_exchange_rate_and_gas_price` function
      let (
        expected_token_exchange_rate,
        expected_gas_price
      ) = gas_oracle::get_exchange_rate_and_gas_price(&oracle_state, BSC_TESTNET_DOMAIN);

      assert!(expected_token_exchange_rate == token_exchange_rate && expected_gas_price == gas_price, 0);

      test_scenario::return_to_address(admin, admin_cap);
      test_scenario::return_shared(oracle_state);
    };

    test_scenario::end(scenario_val);
  }

  #[test]
  fun set_remote_gas_data_list_test() {
    let admin = @0xA;
    let scenario_val = scenario();
    let scenario = &mut scenario_val;
  
    // init module with contract account
    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      gas_oracle::init_for_test(ctx);
    };

    // set exchange rate: 1 BNB = 50 APT
    let token_exchange_rate = 500_000_000_000; 
    // test bsc network gas price
    let gas_price = 100000000000;
    // bsc network gas price
    let mainnet_gas_price = 1000000000;

    next_tx(scenario, admin);
    {
      let admin_cap = test_scenario::take_from_address<gas_oracle::AdminCap>(scenario, admin);
      let oracle_state = test_scenario::take_shared<gas_oracle::OracleState>(scenario);
    
      let ctx = test_scenario::ctx(scenario);

      gas_oracle::set_remote_gas_data_list(
        &admin_cap,
        &mut oracle_state,
        vector[BSC_MAINNET_DOMAIN, BSC_TESTNET_DOMAIN],
        vector[token_exchange_rate, token_exchange_rate],
        vector[mainnet_gas_price, gas_price],
        ctx
      );

      // test `get_exchange_rate_and_gas_price` function
      let (
        expected_token_exchange_rate,
        expected_gas_price
      ) = gas_oracle::get_exchange_rate_and_gas_price(&oracle_state, BSC_MAINNET_DOMAIN);
      assert!(expected_token_exchange_rate == token_exchange_rate && expected_gas_price == mainnet_gas_price, 0);
      
      test_scenario::return_to_address(admin, admin_cap);
      test_scenario::return_shared(oracle_state);
    };
    
    test_scenario::end(scenario_val);
  }

}