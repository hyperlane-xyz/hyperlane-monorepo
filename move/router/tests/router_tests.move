#[test_only]
module hp_router::router_tests {
  use std::signer;
  use std::features;
  use aptos_framework::block;
  use aptos_framework::account;

  use hp_router::router::{Self, RouterCap};
  use hp_isms::multisig_ism;
  use hp_library::test_utils;
  use hp_mailbox::mailbox;

  use hp_igps::igp_tests;

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const APTOS_TESTNET_DOMAIN: u32 = 14402;

  struct TestRouter {}

  struct RouterCapWrapper<phantom T> has key {
    router_cap: RouterCap<T>
  }

  #[test(aptos_framework=@0x1, hp_router=@hp_router)]
  fun enroll_router_test(aptos_framework: signer, hp_router: signer) {
    test_utils::setup(&aptos_framework, &hp_router, vector[]);

    router::init_for_test(&hp_router);
    // init router
    let router_cap = router::init<TestRouter>(&hp_router, APTOS_TESTNET_DOMAIN);
    // keep router_cap in resource
    move_to<RouterCapWrapper<TestRouter>>(&hp_router, RouterCapWrapper { router_cap });
    let bsc_testnet_router = x"57BBb149A040C04344d80FD788FF84f98DDFd391";
    router::enroll_remote_router<TestRouter>(&hp_router, BSC_TESTNET_DOMAIN, bsc_testnet_router);
    
    // check routers and domains
    assert!(router::get_remote_router_for_test<TestRouter>(BSC_TESTNET_DOMAIN) == bsc_testnet_router, 0);
    assert!(router::get_routers<TestRouter>() == vector[bsc_testnet_router], 0);
    assert!(router::get_domains<TestRouter>() == vector[BSC_TESTNET_DOMAIN], 0);

    // do `enroll_remote_routers`
    let new_bsc_testnet_router = x"DFdaB292003F2a8890CdAA39D0B358901886F818";
    let bsc_mainnet_router = x"598264FF31f198f6071226b2B7e9ce360163aCcD";
    router::enroll_remote_routers<TestRouter>(
      &hp_router, 
      vector[BSC_TESTNET_DOMAIN, BSC_MAINNET_DOMAIN], 
      vector[new_bsc_testnet_router, bsc_mainnet_router]
    );

    // check routers and domains
    aptos_std::debug::print<vector<u8>>(&router::get_remote_router_for_test<TestRouter>(BSC_TESTNET_DOMAIN));
    aptos_std::debug::print<vector<u8>>(&router::get_remote_router_for_test<TestRouter>(BSC_MAINNET_DOMAIN));

    assert!(router::get_remote_router_for_test<TestRouter>(BSC_TESTNET_DOMAIN) == new_bsc_testnet_router, 0);
    assert!(router::get_remote_router_for_test<TestRouter>(BSC_MAINNET_DOMAIN) == bsc_mainnet_router, 0);
    assert!(router::get_routers<TestRouter>() == vector[new_bsc_testnet_router, bsc_mainnet_router], 0);
    assert!(router::get_domains<TestRouter>() == vector[BSC_TESTNET_DOMAIN, BSC_MAINNET_DOMAIN], 0);
  }

  #[test(aptos_framework=@0x1, hp_router=@hp_router, hp_mailbox=@hp_mailbox, hp_igps=@hp_igps, alice=@0xa11ce)]
  fun dispatch_test(aptos_framework: signer, hp_router: signer, hp_mailbox: signer, hp_igps: signer, alice: signer) acquires RouterCapWrapper {
    test_utils::setup(&aptos_framework, &hp_router, vector[@hp_mailbox, @hp_igps, @0xa11ce]);
    
    // enable auid feature because mailbox needs to call `get_transaction_hash()`
    let feature = features::get_auids();
    features::change_feature_flags(&aptos_framework, vector[feature], vector[]);

    // block must be initilized because mailbox access block resource
    account::create_account_for_test(@aptos_framework);
    block::initialize_for_test(&aptos_framework, 1000 /* epoch_interval */);

    // init mailbox
    mailbox::init_for_test(&hp_mailbox);
    mailbox::initialize(&hp_mailbox, APTOS_TESTNET_DOMAIN);
    
    // init router module
    router::init_for_test(&hp_router);

    // init typeinfo specific router_state
    let router_cap = router::init<TestRouter>(&hp_router, APTOS_TESTNET_DOMAIN);

    // keep router_cap in resource
    move_to<RouterCapWrapper<TestRouter>>(&hp_router, RouterCapWrapper { router_cap });
    let bsc_testnet_router = x"57BBb149A040C04344d80FD788FF84f98DDFd391";
    router::enroll_remote_router<TestRouter>(&hp_router, BSC_TESTNET_DOMAIN, bsc_testnet_router);
    
    // check routers and domains
    assert!(router::get_remote_router_for_test<TestRouter>(BSC_TESTNET_DOMAIN) == bsc_testnet_router, 0);
    assert!(router::get_routers<TestRouter>() == vector[bsc_testnet_router], 0);
    assert!(router::get_domains<TestRouter>() == vector[BSC_TESTNET_DOMAIN], 0);

    // do `dispatch`
    let message_body = vector[0, 0, 0, 0];
    let cap_wrapper = borrow_global<RouterCapWrapper<TestRouter>>(@hp_router);
    router::dispatch<TestRouter>(BSC_TESTNET_DOMAIN, message_body, &cap_wrapper.router_cap);
    // check if mailbox count increased
    assert!(mailbox::outbox_get_count() == 1, 0);
    // init igp first
    igp_tests::init_igps_for_test(&hp_igps);
    // try dispatching with gas
    router::dispatch_with_gas<TestRouter>(&alice, BSC_TESTNET_DOMAIN, message_body, 10000, &cap_wrapper.router_cap);
    // check if mailbox count increased
    assert!(mailbox::outbox_get_count() == 2, 0);
  }
  
  #[test(aptos_framework=@0x1, hp_router=@hp_router, alice=@0xa11ce)]
  fun transfer_ownership_test(aptos_framework: signer, hp_router: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_router, vector[]);

    router::init_for_test(&hp_router);
    // init router
    let router_cap = router::init<TestRouter>(&hp_router, APTOS_TESTNET_DOMAIN);
    // keep router_cap in resource
    move_to<RouterCapWrapper<TestRouter>>(&hp_router, RouterCapWrapper { router_cap });
    
    router::transfer_ownership<TestRouter>(&hp_router, @0xa11ce);

    // set remote router with `alice` account. because the owner has changed
    let bsc_testnet_router = x"57BBb149A040C04344d80FD788FF84f98DDFd391";
    router::enroll_remote_router<TestRouter>(&alice, BSC_TESTNET_DOMAIN, bsc_testnet_router);

    // check routers and domains
    assert!(router::get_remote_router_for_test<TestRouter>(BSC_TESTNET_DOMAIN) == bsc_testnet_router, 0);
    assert!(router::get_routers<TestRouter>() == vector[bsc_testnet_router], 0);
    assert!(router::get_domains<TestRouter>() == vector[BSC_TESTNET_DOMAIN], 0);
  }

  // Test will fail because non-admin tries setting values
  #[test(aptos_framework=@0x1, hp_router=@hp_router, alice=@0xa11ce)]
  #[expected_failure(abort_code = 1)]
  fun ownership_test(aptos_framework: signer, hp_router: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_router, vector[]);
    
    router::init_for_test(&hp_router);
    // init router
    let router_cap = router::init<TestRouter>(&hp_router, APTOS_TESTNET_DOMAIN);
    // keep router_cap in resource
    move_to<RouterCapWrapper<TestRouter>>(&hp_router, RouterCapWrapper { router_cap });

    // try setting with `alice` but will fail because alice is not an admin
    let bsc_testnet_router = x"57BBb149A040C04344d80FD788FF84f98DDFd391";
    router::enroll_remote_router<TestRouter>(&alice, BSC_TESTNET_DOMAIN, bsc_testnet_router);
  }
}