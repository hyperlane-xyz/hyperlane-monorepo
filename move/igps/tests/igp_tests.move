#[test_only]
module hp_igps::igp_tests {
  use std::signer;
  use std::vector;
  use aptos_framework::coin;
  use aptos_framework::aptos_coin::AptosCoin;

  use hp_igps::igps;
  use hp_igps::gas_oracle;
  use hp_library::test_utils;

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const TOKEN_EXCHANGE_RATE_SCALE: u256 = 10_000_000_000;

  public fun init_igps_for_test(hp_igps: &signer) {
    // init `gas_oracle` module with contract account
    gas_oracle::init_for_test(hp_igps);
    // init `igps` module with contract account
    igps::init_for_test(hp_igps);
  }

  #[test(aptos_framework = @0x1, hp_igps=@hp_igps, alice = @0xa11ce)]
  fun set_remote_gas_data_test(aptos_framework: signer, hp_igps: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_igps, vector[signer::address_of(&alice)]);

    init_igps_for_test(&hp_igps);

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
    ) = igps::get_exchange_rate_and_gas_price(BSC_TESTNET_DOMAIN);

    assert!(expected_token_exchange_rate == token_exchange_rate && expected_gas_price == gas_price, 0);
  }

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

  // Test will fail because non-admin tries setting beneficiary
  #[test(aptos_framework = @0x1, hp_igps=@hp_igps, alice = @0xa11ce)]
  #[expected_failure(abort_code = 1)]
  fun non_admin_tries_setting_beneficiary(aptos_framework: signer, hp_igps: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_igps, vector[signer::address_of(&alice)]);

    // init module with contract account
    igps::init_for_test(&hp_igps);
    // tries setting but should be failed
    igps::set_beneficiary(&alice, @0xb0b);
  }

}