#[test_only]
module hp_router::router_tests {
  use std::signer;
  use std::features;
  use aptos_framework::block;
  use aptos_framework::account;

  use hp_router::router::{Self, RouterCap};
  use hp_library::test_utils;

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const APTOS_TESTNET_DOMAIN: u32 = 14402;

  struct TestRouter {}

  struct TestRouter1 {}

  struct RouterCapWrapper<phantom T> has key {
    router_cap: RouterCap<T>
  }

  #[test(aptos_framework=@0x1, hp_router=@hp_router)]
  fun enroll_router_test(aptos_framework: signer, hp_router: signer) {
    test_utils::setup(&aptos_framework, &hp_router, vector[]);

    router::init_for_test(&hp_router);
    // init router
    let router_cap = router::init<TestRouter>(&hp_router);
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
  
  #[test(aptos_framework=@0x1, hp_router=@hp_router, alice=@0xa11ce)]
  fun transfer_ownership_test(aptos_framework: signer, hp_router: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_router, vector[]);

    router::init_for_test(&hp_router);
    // init router
    let router_cap = router::init<TestRouter>(&hp_router);
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
    let router_cap = router::init<TestRouter>(&hp_router);
    // keep router_cap in resource
    move_to<RouterCapWrapper<TestRouter>>(&hp_router, RouterCapWrapper { router_cap });

    // try setting with `alice` but will fail because alice is not an admin
    let bsc_testnet_router = x"57BBb149A040C04344d80FD788FF84f98DDFd391";
    router::enroll_remote_router<TestRouter>(&alice, BSC_TESTNET_DOMAIN, bsc_testnet_router);
  }

  // Test will fail due to duplicated type info
  #[test(aptos_framework=@0x1, hp_router=@hp_router, alice=@0xa11ce)]
  #[expected_failure(abort_code = 7)]
  fun duplicated_type(aptos_framework: signer, hp_router: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_router, vector[]);
    
    router::init_for_test(&hp_router);
    // init router
    let router_cap = router::init<TestRouter>(&hp_router);
    let router_cap1 = router::init<TestRouter>(&hp_router);
    // keep router_cap in resource
    move_to<RouterCapWrapper<TestRouter>>(&hp_router, RouterCapWrapper { router_cap });
    move_to<RouterCapWrapper<TestRouter>>(&alice, RouterCapWrapper { router_cap: router_cap1 });
  }

  // Test will fail due to duplicated package address
  #[test(aptos_framework=@0x1, hp_router=@hp_router, alice=@0xa11ce)]
  #[expected_failure(abort_code = 8)]
  fun duplicated_package(aptos_framework: signer, hp_router: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_router, vector[]);
    
    router::init_for_test(&hp_router);
    // init router
    let router_cap = router::init<TestRouter>(&hp_router);
    let router1_cap = router::init<TestRouter1>(&hp_router);
    // keep router_cap in resource
    move_to<RouterCapWrapper<TestRouter1>>(&alice, RouterCapWrapper { router_cap: router1_cap });
    move_to<RouterCapWrapper<TestRouter>>(&hp_router, RouterCapWrapper { router_cap });
  }

  // Test will fail due to duplicated package address
  #[test(aptos_framework=@0x1, hp_router=@hp_router, alice=@0xa11ce)]
  fun get_module_name_test(aptos_framework: signer, hp_router: signer, alice: signer) {
    test_utils::setup(&aptos_framework, &hp_router, vector[]);
    
    router::init_for_test(&hp_router);
    // init router
    let router_cap = router::init<TestRouter>(&hp_router);
    move_to<RouterCapWrapper<TestRouter>>(&hp_router, RouterCapWrapper { router_cap });

    // get module name
    let package_addy = router::type_address<TestRouter>();
    let module_name = router::fetch_module_name(package_addy);
    aptos_std::debug::print<vector<u8>>(&module_name);
    assert!(module_name == b"router_tests", 0);
  }
}