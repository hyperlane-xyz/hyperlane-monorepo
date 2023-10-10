// !TODO: add remote router control, gas control
module examples::hello_world {
  use std::vector;
  use hp_router::router;
  use hp_library::msg_utils;
  use hp_mailbox::mailbox;

  // Constants

  const DOMAIN_BSCTESTNET: u32 = 97;
  const DEFAULT_GAS_AMOUNT: u256 = 1_000_000_000;

  // Errors
  const ERROR_INVALID_DOMAIN: u64 = 0;
  
  struct HelloWorld {}

  struct State has key {
    cap: router::RouterCap<HelloWorld>,
    received_messages: vector<vector<u8>>
  }

  /// Initialize Module
  fun init_module(account: &signer) {
    let cap = router::init<HelloWorld>(account);
    move_to<State>(account, State { 
      cap,
      received_messages: vector::empty()
    });
  }

  /// Send single message from aptos to bsctestnet
  public entry fun send_message(
    _account: &signer,
    dest_domain: u32,
    message: vector<u8>
  ) acquires State {
    let state = borrow_global<State>(@examples);

    mailbox::dispatch<HelloWorld>(
      dest_domain,
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
    let state = borrow_global<State>(@examples);

    mailbox::dispatch_with_gas<HelloWorld>(
      account,
      dest_domain,
      message,
      DEFAULT_GAS_AMOUNT,
      &state.cap
    );
  }


  /// Receive message from other chains
  public entry fun handle_message(
    message: vector<u8>,
    metadata: vector<u8>
  ) acquires State {
    let state = borrow_global_mut<State>(@examples);

    mailbox::handle_message<HelloWorld>(
      message,
      metadata,
      &state.cap
    );

    vector::push_back(&mut state.received_messages, msg_utils::body(&message));
  }

  #[test]
  fun get_hello_world_bytes() {
    aptos_std::debug::print<vector<u8>>(&b"Hello World!");
    assert!(x"48656c6c6f20576f726c6421" == b"Hello World!", 0);
  }
}