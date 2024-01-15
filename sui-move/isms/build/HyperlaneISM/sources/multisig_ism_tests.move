#[test_only]
module hp_isms::multisig_ism_tests {
  use sui::test_scenario::{Self, Scenario, next_tx, ctx};

  use hp_isms::multisig_ism::{Self, ISM};
  use hp_library::test_utils::{Self, scenario};

  const BSC_TESTNET_DOMAIN: u32 = 97;

  #[test]
  fun verify_test() {
    let admin = @0xA;
    let scenario_val = scenario();
    let scenario = &mut scenario_val;
    
    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      multisig_ism::init_for_test(ctx);
    };

    next_tx(scenario, admin);
    {
      let admin_cap = test_scenario::take_from_address<multisig_ism::AdminCap>(scenario, admin);
      let ism = test_scenario::take_shared<multisig_ism::ISM>(scenario);
    
      let ctx = test_scenario::ctx(scenario);
      multisig_ism::set_validators_and_threshold(
        &admin_cap, 
        &mut ism,
        vector[@0x598264ff31f198f6071226b2b7e9ce360163accd], 
        1,   // threshold
        BSC_TESTNET_DOMAIN,   // origin_domain
        ctx
      );

      test_scenario::return_to_address(admin, admin_cap);
      test_scenario::return_shared(ism);
    };

    next_tx(scenario, admin);
    {
      let ism = test_scenario::take_shared<multisig_ism::ISM>(scenario);
      let message = x"000000000100000061000000000000000000000000762766499574b689e90defbcd902db92e30a0da100003842080b245c01855eef0870bbf62fb0aa33b975912b57d2f65f45986bea79cf812a48656c6c6f20576f726c6421";
      let metadata = x"0000000000000000000000000ce9034b48110781d815b4eb9156886a1cb5e7f5a8aa4961c9ddcc8632c3b74ddadc5559a00a4ffc483c232725d039bcf3cda20f0f9d81192b0d3b918d668110dc92ed744921161e39b884809d9fcc1d29dfe37273691e09f6fbcc8c6f52c5ab03e5bd44676781b33bea98e052583693aa366bea1b";
      assert!(multisig_ism::verify(&ism, &metadata, &message), 0);
      test_scenario::return_shared(ism);
    };

    test_scenario::end(scenario_val);
  }

  #[test]
  fun set_validators_and_threshold_test() {
        let admin = @0xA;
    let scenario_val = scenario();
    let scenario = &mut scenario_val;
    
    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      multisig_ism::init_for_test(ctx);
    };
    
    next_tx(scenario, admin);
    {
      let admin_cap = test_scenario::take_from_address<multisig_ism::AdminCap>(scenario, admin);
      let ism = test_scenario::take_shared<multisig_ism::ISM>(scenario);
    
      let validators = vector[
        @0x598264ff31f198f6071226b2b7e9ce360163accd,
        @0xc5cb1f1ce6951226e9c46ce8d42eda1ac9774a0fef91e2910939119ef0c95568,
      ];
      let threshold = 1;

      let ctx = test_scenario::ctx(scenario);
      // set validators and threshold
      multisig_ism::set_validators_and_threshold(
        &admin_cap,
        &mut ism, 
        validators, 
        threshold,   // threshold
        BSC_TESTNET_DOMAIN,   // origin_domain
        ctx
      );

      test_scenario::return_to_address(admin, admin_cap);
      test_scenario::return_shared(ism);
    };


    next_tx(scenario, admin);
    {
      let ism = test_scenario::take_shared<multisig_ism::ISM>(scenario);
    
      // check get function
      let (expected_validators, expected_threshold) = multisig_ism::validators_and_threshold(&ism, BSC_TESTNET_DOMAIN);

      let validators = vector[
        @0x598264ff31f198f6071226b2b7e9ce360163accd,
        @0xc5cb1f1ce6951226e9c46ce8d42eda1ac9774a0fef91e2910939119ef0c95568,
      ];
      let threshold = 1;
      assert!(expected_validators == validators && threshold == expected_threshold, 0);
      
      test_scenario::return_shared(ism);
    };
    
    test_scenario::end(scenario_val);
  }
}