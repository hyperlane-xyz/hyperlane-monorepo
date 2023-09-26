#[test_only]
module hp_igps::gas_oracle_tests {
  use std::signer;
  use std::vector;

  use hp_igps::gas_oracle;
  use hp_library::test_utils;

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const TOKEN_EXCHANGE_RATE_SCALE: u256 = 10_000_000_000;

  #[test(aptos_framework = @0x1, hp_igps=@hp_igps, alice = @0xa11ce)]
  fun set_remote_gas_data_test(aptos_framework: signer, hp_igps: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_igps, vector[signer::address_of(&alice)]);

    // init module with contract account
    gas_oracle::init_for_test(&hp_igps);

    // set exchange rate: 1 BNB = 50 APT
    let token_exchange_rate = 500_000_000_000; 
    // bsc network gas price
    let gas_price = 100000000000;

    gas_oracle::set_remote_gas_data(
      &hp_igps,
      BSC_TESTNET_DOMAIN,
      token_exchange_rate,
      gas_price
    );

    // test `get_exchange_rate_and_gas_price` function
    let (
      expected_token_exchange_rate,
      expected_gas_price
    ) = gas_oracle::get_exchange_rate_and_gas_price(BSC_TESTNET_DOMAIN);

    assert!(expected_token_exchange_rate == token_exchange_rate && expected_gas_price == gas_price, 0);
  }

  #[test(aptos_framework = @0x1, hp_igps=@hp_igps, alice = @0xa11ce)]
  fun set_remote_gas_data_list_test(aptos_framework: signer, hp_igps: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_igps, vector[signer::address_of(&alice)]);

    // init module with contract account
    gas_oracle::init_for_test(&hp_igps);

    // set exchange rate: 1 BNB = 50 APT
    let token_exchange_rate = 500_000_000_000; 
    // test bsc network gas price
    let gas_price = 100000000000;
    // bsc network gas price
    let mainnet_gas_price = 1000000000;
    gas_oracle::set_remote_gas_data_list(
      &hp_igps,
      vector[BSC_MAINNET_DOMAIN, BSC_TESTNET_DOMAIN],
      vector[token_exchange_rate, token_exchange_rate],
      vector[mainnet_gas_price, gas_price]
    );

    // test `get_exchange_rate_and_gas_price` function
    let (
      expected_token_exchange_rate,
      expected_gas_price
    ) = gas_oracle::get_exchange_rate_and_gas_price(BSC_MAINNET_DOMAIN);

    assert!(expected_token_exchange_rate == token_exchange_rate && expected_gas_price == mainnet_gas_price, 0);
  }

  /// Test will fail because non-admin tries setting gas data
  #[test(aptos_framework = @0x1, hp_igps=@hp_igps, alice = @0xa11ce)]
  #[expected_failure(abort_code = 1)]
  fun non_admin_tries_setting_gas_data(aptos_framework: signer, hp_igps: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_igps, vector[signer::address_of(&alice)]);

    // init module with contract account
    gas_oracle::init_for_test(&hp_igps);

    // set exchange rate: 1 BNB = 50 APT
    let token_exchange_rate = 500_000_000_000; 
    // test bsc network gas price
    let gas_price = 100000000000;
    // bsc network gas price
    let mainnet_gas_price = 1000000000;
    gas_oracle::set_remote_gas_data_list(
      &alice,
      vector[BSC_MAINNET_DOMAIN, BSC_TESTNET_DOMAIN],
      vector[token_exchange_rate, token_exchange_rate],
      vector[mainnet_gas_price, gas_price]
    );
  }

}