#[test_only]
module hp_mailbox::mailbox_tests {
  use std::vector;
  use std::signer;
  use std::features;
  use std::string::{Self, String};
  use aptos_framework::block;
  use aptos_framework::account;

  use hp_mailbox::mailbox;
  use hp_igps::igp_tests;
  use hp_library::test_utils;
  use hp_router::router::{Self, RouterCap};

  const BSC_TESTNET_DOMAIN: u32 = 97;
  const BSC_MAINNET_DOMAIN: u32 = 56;
  const APTOS_TESTNET_DOMAIN: u32 = 14402;

  struct TestRouter {}

  struct RouterCapWrapper<phantom T> has key {
    router_cap: RouterCap<T>
  }

  #[test(aptos_framework=@0x1, hp_router=@hp_router, hp_mailbox=@hp_mailbox, hp_igps=@hp_igps, alice=@0xa11ce)]
  fun dispatch_test(aptos_framework: signer, hp_router: signer, hp_mailbox: signer, hp_igps: signer, alice: signer) acquires RouterCapWrapper {
    test_utils::setup(&aptos_framework, &hp_mailbox, vector[@hp_mailbox, @hp_igps, @0xa11ce]);
    
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
    let router_cap = router::init<TestRouter>(&hp_mailbox);

    // keep router_cap in resource
    move_to<RouterCapWrapper<TestRouter>>(&hp_mailbox, RouterCapWrapper { router_cap });
    let bsc_testnet_router = x"57BBb149A040C04344d80FD788FF84f98DDFd391";
    router::enroll_remote_router<TestRouter>(&hp_mailbox, BSC_TESTNET_DOMAIN, bsc_testnet_router);
    
    // check routers and domains
    assert!(router::get_remote_router_for_test<TestRouter>(BSC_TESTNET_DOMAIN) == bsc_testnet_router, 0);
    assert!(router::get_routers<TestRouter>() == vector[bsc_testnet_router], 0);
    assert!(router::get_domains<TestRouter>() == vector[BSC_TESTNET_DOMAIN], 0);

    // do `dispatch`
    let message_body = vector[0, 0, 0, 0];
    let cap_wrapper = borrow_global<RouterCapWrapper<TestRouter>>(@hp_mailbox);
    mailbox::dispatch<TestRouter>(BSC_TESTNET_DOMAIN, message_body, &cap_wrapper.router_cap);
    // check if mailbox count increased
    assert!(mailbox::outbox_get_count() == 1, 0);
    // init igp first
    igp_tests::init_igps_for_test(&hp_igps);
    // try dispatching with gas
    mailbox::dispatch_with_gas<TestRouter>(&alice, BSC_TESTNET_DOMAIN, message_body, 10000, &cap_wrapper.router_cap);
    // check if mailbox count increased
    assert!(mailbox::outbox_get_count() == 2, 0);
  }
}