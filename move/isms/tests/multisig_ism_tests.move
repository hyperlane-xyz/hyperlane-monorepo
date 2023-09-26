#[test_only]
module hp_isms::multisig_ism_tests {
  use std::signer;

  use hp_isms::multisig_ism;
  use hp_library::test_utils;

  const BSC_TESTNET_DOMAIN: u32 = 97;

  #[test(aptos_framework=@0x1, alice=@hp_isms)]
  fun verify_test(aptos_framework: signer, alice: signer) {
    multisig_ism::init_for_test(&alice);
    multisig_ism::set_validators_and_threshold(
      &alice, 
      vector[@0x598264ff31f198f6071226b2b7e9ce360163accd], 
      1,   // threshold
      BSC_TESTNET_DOMAIN   // origin_domain
    );
    let message = x"000000000100000061000000000000000000000000762766499574b689e90defbcd902db92e30a0da100003842080b245c01855eef0870bbf62fb0aa33b975912b57d2f65f45986bea79cf812a48656c6c6f20576f726c6421";
    let metadata = x"0000000000000000000000000ce9034b48110781d815b4eb9156886a1cb5e7f5a8aa4961c9ddcc8632c3b74ddadc5559a00a4ffc483c232725d039bcf3cda20f0f9d81192b0d3b918d668110dc92ed744921161e39b884809d9fcc1d29dfe37273691e09f6fbcc8c6f52c5ab03e5bd44676781b33bea98e052583693aa366bea1b";
    assert!(multisig_ism::verify(&metadata, &message), 0);
  }

  #[test(aptos_framework=@0x1, alice=@hp_isms)]
  fun set_validators_and_threshold_test(aptos_framework: signer, alice: signer) {
    multisig_ism::init_for_test(&alice);
    
    let validators = vector[
      @0x598264ff31f198f6071226b2b7e9ce360163accd,
      @0xc5cb1f1ce6951226e9c46ce8d42eda1ac9774a0fef91e2910939119ef0c95568,
    ];
    let threshold = 1;

    // set validators and threshold
    multisig_ism::set_validators_and_threshold(
      &alice, 
      validators, 
      threshold,   // threshold
      BSC_TESTNET_DOMAIN   // origin_domain
    );

    // check get function
    let (expected_validators, expected_threshold) = multisig_ism::validators_and_threshold(BSC_TESTNET_DOMAIN);
    assert!(expected_validators == validators && threshold == expected_threshold, 0);
  }

  // Test will fail because non-admin tries setting validators and threshold
  #[test(aptos_framework = @0x1, hp_isms=@hp_isms, alice = @0xa11ce)]
  #[expected_failure(abort_code = 1)]
  fun non_admin_tries_setting_beneficiary(aptos_framework: signer, hp_isms: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_isms, vector[signer::address_of(&alice)]);

    // init module with contract account
    multisig_ism::init_for_test(&hp_isms);
    // tries setting but should be failed
    multisig_ism::set_validators_and_threshold(
      &alice, 
      vector[@0x598264ff31f198f6071226b2b7e9ce360163accd], 
      1,   // threshold
      BSC_TESTNET_DOMAIN   // origin_domain
    );
  }
}