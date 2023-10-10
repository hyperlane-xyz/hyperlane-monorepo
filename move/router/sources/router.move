module hp_router::router {
  
  use std::vector;
  use std::signer;
  use aptos_framework::account;
  use aptos_framework::event::{Self, EventHandle};
  use aptos_std::simple_map::{Self, SimpleMap};
  use aptos_std::type_info::{Self, TypeInfo};

  use hp_library::msg_utils;
  use hp_library::h256;
  use hp_router::events::{Self, EnrollRemoteRouterEvent};

  //
  // Errors
  //

  const ERROR_INVALID_OWNER: u64 = 1;
  const ERROR_PARAMS_LENGTH_MISMATCH: u64 = 2;
  const ERROR_NO_ROUTER_ENROLLED: u64 = 3;
  const ERROR_INVALID_ROUTER: u64 = 4;
  const ERROR_INVALID_TYPE_PARAM: u64 = 5;
  const ERROR_ROUTER_ALREADY_INITED: u64 = 6;
  const ERROR_DUPLICATED_TYPEINFO: u64 = 7;
  const ERROR_DUPLICATED_PACKAGE: u64 = 8;
  
  //
  // Constants
  //
  const APTOS_TESTNET_DOMAIN: u32 = 14402;
  
  //
  // Resources
  //

  struct RouterRegistry has key {
    package_map: SimpleMap<address, vector<u8>>,
    router_state_map: SimpleMap<TypeInfo, RouterState>,
    local_domain: u32,
  }

  struct RouterState has store {
    owner_address: address,
    routers: SimpleMap<u32, vector<u8>>,
    // event handle
    enroll_router_events: EventHandle<EnrollRemoteRouterEvent>
  }

  struct RouterCap<phantom T> has store {}

  fun init_module(account: &signer) {
    move_to<RouterRegistry>(account, RouterRegistry {
      // map (package_addy => module_name)
      package_map: simple_map::create<address, vector<u8>>(),
      // map (package_addy::module_name => RouterState)
      router_state_map: simple_map::create<TypeInfo, RouterState>(),
      local_domain: APTOS_TESTNET_DOMAIN
    });
  }

  public fun init<T>(account: &signer): RouterCap<T> acquires RouterRegistry {
    let account_address = signer::address_of(account);

    // Type T should be declared within that account address
    assert_type_and_account_same_address<T>(account_address);

    let registry = borrow_global_mut<RouterRegistry>(@hp_router);
    assert_type_is_not_exist<T>(registry);

    simple_map::add(&mut registry.router_state_map, type_info::type_of<T>(), RouterState {
      owner_address: account_address,
      routers: simple_map::create<u32, vector<u8>>(),
      enroll_router_events: account::new_event_handle<EnrollRemoteRouterEvent>(account)
    });

    // add package
    assert_package_is_not_exist<T>(registry);
    simple_map::add(&mut registry.package_map, type_address<T>(), module_name<T>());

    RouterCap<T> {}
  }

  /// Transfer ownership
  public fun transfer_ownership<T>(account: &signer, new_owner: address) acquires RouterRegistry {
    let account_address = signer::address_of(account);
    assert_owner_address<T>(account_address);
    let registry = borrow_global_mut<RouterRegistry>(@hp_router);
    let state = simple_map::borrow_mut(&mut registry.router_state_map, &type_info::type_of<T>());
    state.owner_address = new_owner;
  }
  
  /**
   * @notice Register the address of a Router contract for the same Application on a remote chain
   */
  public entry fun enroll_remote_router<T>(
    account: &signer,
    domain: u32,
    remote_router: vector<u8>
  ) acquires RouterRegistry {
    let account_address = signer::address_of(account);
    assert_owner_address<T>(account_address);
    
    let registry = borrow_global_mut<RouterRegistry>(@hp_router);
    let state = simple_map::borrow_mut(&mut registry.router_state_map, &type_info::type_of<T>());

    internal_enroll_remote_router(state, domain, remote_router);
  }

  /**
   * @notice Batch version of `enrollRemoteRouter`
   */
  public entry fun enroll_remote_routers<T>(
    account: &signer,
    domains: vector<u32>,
    remote_routers: vector<vector<u8>>
  ) acquires RouterRegistry {
    let account_address = signer::address_of(account);
    assert_owner_address<T>(account_address);
    assert_params_length_should_be_same(&domains, &remote_routers);

    let registry = borrow_global_mut<RouterRegistry>(@hp_router);
    let state = simple_map::borrow_mut(&mut registry.router_state_map, &type_info::type_of<T>());

    let len = vector::length(&domains);
    let i = 0;
    while ( i < len ) {
      let domain = *vector::borrow(&domains, i);
      let router = *vector::borrow(&remote_routers, i);
      internal_enroll_remote_router(state, domain, router);
      i = i + 1;
    };
  }

  /**
   * Internal function to enroll remote router
   */
  fun internal_enroll_remote_router(
    state: &mut RouterState,
    domain: u32,
    remote_router: vector<u8>
  ) {
    if (!simple_map::contains_key(&state.routers, &domain)) {
      simple_map::add(&mut state.routers, domain, remote_router);
    } else {
      let router_address = simple_map::borrow_mut(&mut state.routers, &domain);
      *router_address = remote_router;
    };

    event::emit_event<EnrollRemoteRouterEvent>(
      &mut state.enroll_router_events,
      events::new_enroll_remote_router_event(
        domain,
        remote_router
      )
    );
  }

  /// Check and return remote router address
  public fun must_have_remote_router<T>(domain: u32): vector<u8> acquires RouterRegistry {
    let registry = borrow_global<RouterRegistry>(@hp_router);
    let state = simple_map::borrow(&registry.router_state_map, &type_info::type_of<T>());
    assert!(simple_map::contains_key(&state.routers, &domain), ERROR_NO_ROUTER_ENROLLED);
    *simple_map::borrow(&state.routers, &domain)
  }

  /// Get address of type T
  public fun type_address<T>(): address {
    type_info::account_address(&type_info::type_of<T>())
  }

  /// Get module name of type T
  public fun module_name<T>(): vector<u8> {
    type_info::module_name(&type_info::type_of<T>())
  }

  //
  // Assert Functions
  //

  /// Check vector length
  inline fun assert_params_length_should_be_same(domains: &vector<u32>, remote_routers: &vector<vector<u8>>) {
    assert!(vector::length(domains) == vector::length(remote_routers), ERROR_PARAMS_LENGTH_MISMATCH);
  }

  /// Check ownership
  inline fun assert_owner_address<T>(account_address: address) acquires RouterRegistry {
    let registry = borrow_global<RouterRegistry>(@hp_router);
    let router_state = simple_map::borrow(&registry.router_state_map, &type_info::type_of<T>());
    assert!(router_state.owner_address == account_address, ERROR_INVALID_OWNER);
  }

  /// Check type address
  inline fun assert_type_and_account_same_address<T>(account_address: address) {
    assert!(type_address<T>() == account_address, ERROR_INVALID_TYPE_PARAM);
  }

  /// Check if router already exists
  inline fun assert_router_should_not_exist<T>(account_address: address) acquires RouterRegistry {
    let registry = borrow_global<RouterRegistry>(@hp_router);
    assert!(!simple_map::contains_key(&registry.router_state_map, &type_info::type_of<T>()), ERROR_ROUTER_ALREADY_INITED)
  }

  /// Check if type is already exist
  inline fun assert_type_is_not_exist<T>(registry: &RouterRegistry) {
    assert!(!simple_map::contains_key(&registry.router_state_map, &type_info::type_of<T>()), ERROR_DUPLICATED_TYPEINFO);
  }

  /// Check if package is already exist
  inline fun assert_package_is_not_exist<T>(registry: &RouterRegistry) {
    assert!(!simple_map::contains_key(&registry.package_map, &type_address<T>()), ERROR_DUPLICATED_PACKAGE);
  }

  /// Check domain and router address
  public fun assert_router_should_be_enrolled<T>(domain: u32, router_address: vector<u8>) acquires RouterRegistry {
    let enrolled_router = must_have_remote_router<T>(domain);
    assert!(enrolled_router == router_address, ERROR_INVALID_ROUTER);
  }

  //
  // View Functions
  //

  #[view]
  public fun get_routers<T>(): vector<vector<u8>> acquires RouterRegistry {
    let registry = borrow_global<RouterRegistry>(@hp_router);
    let router_state = simple_map::borrow(&registry.router_state_map, &type_info::type_of<T>());
    simple_map::values(&router_state.routers)
  }

  #[view]
  public fun get_domains<T>(): vector<u32> acquires RouterRegistry {
    let registry = borrow_global<RouterRegistry>(@hp_router);
    let router_state = simple_map::borrow(&registry.router_state_map, &type_info::type_of<T>());
    simple_map::keys(&router_state.routers)
  }

  #[view]
  public fun fetch_module_name(package_addr: address): vector<u8> acquires RouterRegistry {
    let registry = borrow_global<RouterRegistry>(@hp_router);
    if (!simple_map::contains_key(&registry.package_map, &package_addr)) {
      vector::empty<u8>()
    } else {
      let package_module_name = simple_map::borrow(&registry.package_map, &package_addr);
      *package_module_name
    }
  }


  #[test_only]
  public fun init_for_test(account: &signer) {
    init_module(account);
  }

  #[test_only]
  public fun get_remote_router_for_test<T>(domain: u32): vector<u8> acquires RouterRegistry {
    must_have_remote_router<T>(domain)
  }
}