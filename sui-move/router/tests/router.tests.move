#[test_only]
module hp_router::router_tests {
  use sui::object::{Self, UID};
  use sui::transfer::{Self};
  use sui::test_scenario::{Self, Scenario, next_tx, ctx};
  use sui::tx_context::{Self};
  use hp_library::test_utils::{Self, scenario};
  use hp_router::router::{Self, RouterCap, RouterRegistry};

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const APTOS_TESTNET_DOMAIN: u32 = 14402;

  struct TestRouter {}

  struct TestRouter1 {}

  struct RouterCapWrapper<phantom T> has key {
    id: UID,
    router_cap: RouterCap<T>
  }

  #[test]
  fun enroll_router_test() {

    let admin = @0xA;
    let scenario_val = scenario();
    let scenario = &mut scenario_val;
    
    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      router::init_for_test(ctx);
    };
    
    next_tx(scenario, admin);
    {
      let router_registry = test_scenario::take_shared<RouterRegistry>(scenario);
      // init router
      let ctx = test_scenario::ctx(scenario);
      let router_cap = router::init_router<TestRouter>(&mut router_registry, ctx);
      transfer::transfer(RouterCapWrapper<TestRouter> { id: object::new(ctx), router_cap }, tx_context::sender(ctx));

      test_scenario::return_shared(router_registry);
    };

    
    next_tx(scenario, admin);
    {
      let router_registry = test_scenario::take_shared<RouterRegistry>(scenario);

      let bsc_testnet_router = x"57BBb149A040C04344d80FD788FF84f98DDFd391";
      let ctx = test_scenario::ctx(scenario);
      router::enroll_remote_router<TestRouter>(&mut router_registry, BSC_TESTNET_DOMAIN, bsc_testnet_router, ctx);

      // check routers and domains
      assert!(router::get_remote_router_for_test<TestRouter>(&router_registry, BSC_TESTNET_DOMAIN) == bsc_testnet_router, 0);
      assert!(router::get_routers<TestRouter>(&router_registry) == vector[bsc_testnet_router], 0);
      assert!(router::get_domains<TestRouter>(&router_registry) == vector[BSC_TESTNET_DOMAIN], 0);

      test_scenario::return_shared(router_registry);
    };
    
    next_tx(scenario, admin);
    {
      let router_registry = test_scenario::take_shared<RouterRegistry>(scenario);

      // do `enroll_remote_routers`
      let new_bsc_testnet_router = x"DFdaB292003F2a8890CdAA39D0B358901886F818";
      let bsc_mainnet_router = x"598264FF31f198f6071226b2B7e9ce360163aCcD";
      let ctx = test_scenario::ctx(scenario);
      router::enroll_remote_routers<TestRouter>(
        &mut router_registry,
        vector[BSC_TESTNET_DOMAIN, BSC_MAINNET_DOMAIN], 
        vector[new_bsc_testnet_router, bsc_mainnet_router],
        ctx
      );

      // check routers and domains
      std::debug::print<vector<u8>>(&router::get_remote_router_for_test<TestRouter>(&router_registry, BSC_TESTNET_DOMAIN));
      std::debug::print<vector<u8>>(&router::get_remote_router_for_test<TestRouter>(&router_registry, BSC_MAINNET_DOMAIN));

      assert!(router::get_remote_router_for_test<TestRouter>(&router_registry, BSC_TESTNET_DOMAIN) == new_bsc_testnet_router, 0);
      assert!(router::get_remote_router_for_test<TestRouter>(&router_registry, BSC_MAINNET_DOMAIN) == bsc_mainnet_router, 0);
      assert!(router::get_routers<TestRouter>(&router_registry) == vector[new_bsc_testnet_router, bsc_mainnet_router], 0);
      assert!(router::get_domains<TestRouter>(&router_registry) == vector[BSC_TESTNET_DOMAIN, BSC_MAINNET_DOMAIN], 0);

      test_scenario::return_shared(router_registry);
    };

    test_scenario::end(scenario_val);

  }

  // Test will fail due to duplicated package address
  #[test]
  fun get_module_name_test() {
    let admin = @0xA;
    let scenario_val = scenario();
    let scenario = &mut scenario_val;

    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      router::init_for_test(ctx);
    };
    
    next_tx(scenario, admin);
    {
      let router_registry = test_scenario::take_shared<RouterRegistry>(scenario);
      // init router
      let ctx = test_scenario::ctx(scenario);
      let router_cap = router::init_router<TestRouter>(&mut router_registry, ctx);
      transfer::transfer(RouterCapWrapper<TestRouter> { id: object::new(ctx), router_cap }, tx_context::sender(ctx));
      test_scenario::return_shared(router_registry);
    };
    
    next_tx(scenario, admin);
    {
      let router_registry = test_scenario::take_shared<RouterRegistry>(scenario);
      // get module name
      let package_addy = router::type_address<TestRouter>();
      let module_name = router::fetch_module_name(&router_registry, package_addy);
      std::debug::print<vector<u8>>(&module_name);
      assert!(module_name == b"router_tests", 0);
      test_scenario::return_shared(router_registry);
    };

    test_scenario::end(scenario_val);
  }
}