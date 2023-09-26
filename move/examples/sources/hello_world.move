// !TODO: add remote router control, gas control
module examples::hello_world {

  use hp_router::router;

  // Constants

  const DOMAIN_BSCTESTNET: u32 = 97;
  const DOMAIN_APTOSTESTNET: u32 = 14402;
  const DEFAULT_GAS_AMOUNT: u256 = 1_000_000_000;

  // Errors
  const ERROR_INVALID_DOMAIN: u64 = 0;
  
  struct HelloWorld {}

  struct State has key {
    cap: router::RouterCap<HelloWorld>
  }

  /// Initialize Module
  fun init_module(account: &signer) {
    let cap = router::init<HelloWorld>(account, DOMAIN_APTOSTESTNET);
    move_to<State>(account, State {
      cap
    });
  }

  /// Send single message from aptos to bsctestnet
  public entry fun send_message(
    _account: &signer,
    dest_domain: u32,
    message: vector<u8>
  ) acquires State {
    assert!(dest_domain == DOMAIN_BSCTESTNET, ERROR_INVALID_DOMAIN);

    let state = borrow_global<State>(@examples);

    router::dispatch<HelloWorld>(
      DOMAIN_BSCTESTNET,
      message,
      &state.cap
    );
  }

  /// Send single message from aptos to bsctestnet
  public entry fun send_message_with_gas(
    account: &signer,
    dest_domain: u32,
    message: vector<u8>
  ) acquires State {
    assert!(dest_domain == DOMAIN_BSCTESTNET, ERROR_INVALID_DOMAIN);

    let state = borrow_global<State>(@examples);

    router::dispatch_with_gas<HelloWorld>(
      account,
      DOMAIN_BSCTESTNET,
      message,
      DEFAULT_GAS_AMOUNT,
      &state.cap
    );
  }


  /// Receive message from other chains
  public fun handle_message(
    message: vector<u8>,
    metadata: vector<u8>
  ) acquires State {
    let state = borrow_global<State>(@examples);

    router::handle<HelloWorld>(
      message,
      metadata,
      &state.cap
    );
  }

  #[test]
  fun get_hello_world_bytes() {
    aptos_std::debug::print<vector<u8>>(&b"Hello World!");
    assert!(x"48656c6c6f20576f726c6421" == b"Hello World!", 0);
  }
}