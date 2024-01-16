// todo: not yet done
#[test_only]
module hp_mailbox::mailbox_tests {
  use std::vector;
  use sui::object::{Self, UID};
  use sui::transfer::{Self};
  use sui::test_scenario::{Self, Scenario, next_tx, ctx};
  use sui::tx_context::{Self};
  use hp_mailbox::mailbox::{Self, AdminCap, MailBoxState};
  use hp_library::test_utils::{Self, scenario};
  use hp_igps::igp_tests;
  use hp_router::router::{Self, RouterCap, RouterRegistry};

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const APTOS_TESTNET_DOMAIN: u32 = 14402;

  struct TestRouter {}

  struct RouterCapWrapper<phantom T> has key {
    id: UID,
    router_cap: RouterCap<T>
  }

  #[test]
  fun dispatch_test() {

    let admin = @0xA;
    let scenario_val = scenario();
    let scenario = &mut scenario_val;

    next_tx(scenario, admin);
    {
      let ctx = test_scenario::ctx(scenario);
      // init mailbox
      mailbox::init_for_test(ctx);
    };
    
    next_tx(scenario, admin);
    {
      let admin_cap = test_scenario::take_from_address<AdminCap>(scenario, admin);
      mailbox::create_state(&admin_cap, APTOS_TESTNET_DOMAIN, test_scenario::ctx(scenario));
      test_scenario::return_to_address(admin, admin_cap);
    };

    
    next_tx(scenario, admin);
    {
      // init router module
      router::init_for_test(test_scenario::ctx(scenario));
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
    
    // do `dispatch`
    let message_body = vector[0, 0, 0, 0];
    
    next_tx(scenario, admin);
    {
      let mailbox_state = test_scenario::take_shared<MailBoxState>(scenario);
      let router_registry = test_scenario::take_shared<RouterRegistry>(scenario);
      let cap_wrapper = test_scenario::take_from_address<RouterCapWrapper<TestRouter>>(scenario, admin);
      mailbox::dispatch<TestRouter>(&mut mailbox_state, &router_registry, BSC_TESTNET_DOMAIN, message_body, &cap_wrapper.router_cap, test_scenario::ctx(scenario));
      // check if mailbox count increased
      assert!(mailbox::outbox_get_count(&mailbox_state) == 1, 0);
      test_scenario::return_shared(router_registry);
      test_scenario::return_shared(mailbox_state);
      test_scenario::return_to_address(admin, cap_wrapper);
    };

    test_scenario::end(scenario_val);
  }
}