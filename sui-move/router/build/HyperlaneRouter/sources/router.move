module hp_router::router {
  
  use std::vector;
  use std::string;
  use std::ascii;
  use std::type_name::{Self, TypeName};
  use sui::address;
  use sui::vec_map::{Self, VecMap};
  use sui::object::{Self, ID, UID};
  use sui::transfer;
  use sui::tx_context::{Self, TxContext};
  use sui::event;

  use hp_library::msg_utils;
  use hp_library::h256;

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
  const SUI_TESTNET_DOMAIN: u32 = 15502;
  
  //
  // Events
  //
  struct EnrollRemoteRouterEvent has store, drop, copy {
    domain: u32,
    router: vector<u8>
  }

  //
  // Resources
  //
   
  struct AdminCap has key, store {
    id: UID,
  }

  struct RouterRegistry has key {
    id: UID,
    package_map: VecMap<address, vector<u8>>,
    router_state_map: VecMap<TypeName, RouterState>,
    local_domain: u32,
  }

  struct RouterState has store {
    owner_address: address,
    routers: VecMap<u32, vector<u8>>,
  }

  struct RouterCap<phantom T> has store {}

  fun init(ctx: &mut TxContext) {
    let sender = tx_context::sender(ctx);
    transfer::transfer(AdminCap { id: object::new(ctx) }, sender);
    transfer::share_object(RouterRegistry {
      id: object::new(ctx),
      // map (package_addy => module_name)
      package_map: vec_map::empty<address, vector<u8>>(),
      // map (package_addy::module_name => RouterState)
      router_state_map: vec_map::empty<TypeName, RouterState>(),
      local_domain: SUI_TESTNET_DOMAIN
    });
  }

  public fun init_router<T>(
    registry: &mut RouterRegistry,
    ctx: &mut TxContext
  ): RouterCap<T> {
    let sender_address = tx_context::sender(ctx);

    // Type T should be declared within that account address
    assert_type_and_account_same_address<T>(sender_address);

    assert_type_is_not_exist<T>(registry);

    vec_map::insert(&mut registry.router_state_map, get_type<T>(), RouterState {
      owner_address: sender_address,
      routers: vec_map::empty<u32, vector<u8>>()
    });

    // add package
    assert_package_is_not_exist<T>(registry);
    vec_map::insert(&mut registry.package_map, type_address<T>(), module_name<T>());

    RouterCap<T> {}
  }

  /// Transfer ownership
  public fun transfer_ownership<T>(
    registry: &mut RouterRegistry,
    new_owner: address,
    ctx: &mut TxContext
  ) acquires RouterRegistry {
    let sender_address = tx_context::sender(ctx);
    assert_owner_address<T>(registry, sender_address);
    let state = vec_map::get_mut(&mut registry.router_state_map, &get_type<T>());
    state.owner_address = new_owner;
  }
  
  /**
   * @notice Register the address of a Router contract for the same Application on a remote chain
   */
  public entry fun enroll_remote_router<T>(
    registry: &mut RouterRegistry,
    domain: u32,
    remote_router: vector<u8>,
    ctx: &mut TxContext
  ) acquires RouterRegistry {
    let sender_address = tx_context::sender(ctx);
    assert_owner_address<T>(registry, sender_address);
    
    let state = vec_map::get_mut(&mut registry.router_state_map, &get_type<T>());

    internal_enroll_remote_router(state, domain, remote_router);
  }

  /**
   * @notice Batch version of `enrollRemoteRouter`
   */
  public entry fun enroll_remote_routers<T>(
    registry: &mut RouterRegistry,
    domains: vector<u32>,
    remote_routers: vector<vector<u8>>,
    ctx: &mut TxContext
  ) acquires RouterRegistry {
    let sender_address = tx_context::sender(ctx);
    assert_owner_address<T>(registry, sender_address);
    assert_params_length_should_be_same(&domains, &remote_routers);

    let state = vec_map::get_mut(&mut registry.router_state_map, &get_type<T>());

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
    if (!vec_map::contains(&state.routers, &domain)) {
      vec_map::insert(&mut state.routers, domain, remote_router);
    } else {
      let router_address = vec_map::get_mut(&mut state.routers, &domain);
      *router_address = remote_router;
    };

    // emit dispatch event
    event::emit(EnrollRemoteRouterEvent {
        domain,
        router: remote_router
    });

  }

  /// Check and return remote router address
  public fun must_have_remote_router<T>(
    registry: &RouterRegistry,
    domain: u32
  ): vector<u8> {
    let state = vec_map::get(&registry.router_state_map, &get_type<T>());
    assert!(vec_map::contains(&state.routers, &domain), ERROR_NO_ROUTER_ENROLLED);
    *vec_map::get(&state.routers, &domain)
  }

  /// Get address of type T
  public fun type_address<T>(): address {
    let addr = type_name::get_address(&type_name::get<T>());
    address::from_bytes(ascii::into_bytes(addr))
  }

  /// Get module name of type T
  public fun module_name<T>(): vector<u8> {
    let module_name = type_name::get_module(&type_name::get<T>());
    ascii::into_bytes(module_name)
  }

  /// Get TypeName of type T
  public fun get_type<T>(): TypeName {
    type_name::get<T>()
  }

  //
  // Assert Functions
  //

  /// Check vector length
  fun assert_params_length_should_be_same(domains: &vector<u32>, remote_routers: &vector<vector<u8>>) {
    assert!(vector::length(domains) == vector::length(remote_routers), ERROR_PARAMS_LENGTH_MISMATCH);
  }

  /// Check ownership
  fun assert_owner_address<T>(registry: &RouterRegistry, account_address: address)  {
    let router_state = vec_map::get(&registry.router_state_map, &get_type<T>());
    assert!(router_state.owner_address == account_address, ERROR_INVALID_OWNER);
  }

  /// Check type address
  fun assert_type_and_account_same_address<T>(account_address: address) {
    assert!(type_address<T>() == account_address, ERROR_INVALID_TYPE_PARAM);
  }

  /// Check if router already exists
  fun assert_router_should_not_exist<T>(registry: &RouterRegistry, account_address: address) {
    assert!(!vec_map::contains(&registry.router_state_map, &get_type<T>()), ERROR_ROUTER_ALREADY_INITED)
  }

  /// Check if type is already exist
  fun assert_type_is_not_exist<T>(registry: &RouterRegistry) {
    assert!(!vec_map::contains(&registry.router_state_map, &get_type<T>()), ERROR_DUPLICATED_TYPEINFO);
  }

  /// Check if package is already exist
  fun assert_package_is_not_exist<T>(registry: &RouterRegistry) {
    assert!(!vec_map::contains(&registry.package_map, &type_address<T>()), ERROR_DUPLICATED_PACKAGE);
  }

  /// Check domain and router address
  public fun assert_router_should_be_enrolled<T>(registry: &RouterRegistry, domain: u32, router_address: vector<u8>) {
    let enrolled_router = must_have_remote_router<T>(registry, domain);
    assert!(enrolled_router == router_address, ERROR_INVALID_ROUTER);
  }

  //
  // View Functions
  //


  #[view]
  public fun get_routers<T>(registry: &RouterRegistry): vector<vector<u8>> {
    let router_state = vec_map::get(&registry.router_state_map, &get_type<T>());
    let domains: vector<u32> = vec_map::keys(&router_state.routers);
    let results: vector<vector<u8>> = vector::empty();
    let i = 0;
    while (i < vector::length(&domains)) {
      let value = vec_map::get(&router_state.routers, vector::borrow(&domains, i));
      vector::push_back(&mut results, *value);
      i = i + 1;
    };
    results
  }

  #[view]
  public fun get_domains<T>(registry: &RouterRegistry): vector<u32> {
    let router_state = vec_map::get(&registry.router_state_map, &get_type<T>());
    vec_map::keys(&router_state.routers)
  }

  #[view]
  public fun fetch_module_name(registry: &RouterRegistry, package_addr: address): vector<u8> {
    if (!vec_map::contains(&registry.package_map, &package_addr)) {
      vector::empty<u8>()
    } else {
      let package_module_name = vec_map::get(&registry.package_map, &package_addr);
      *package_module_name
    }
  }

  #[test_only]
  public fun get_remote_router_for_test<T>(registry: &RouterRegistry, domain: u32): vector<u8> {
    must_have_remote_router<T>(registry, domain)
  }
  

  #[test_only]
  public fun init_for_test(ctx: &mut TxContext) {
    init(ctx);
  }
}