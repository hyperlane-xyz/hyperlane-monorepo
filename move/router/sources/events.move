module hp_router::events {
  
  friend hp_router::router;

  // event resources
  struct EnrollRemoteRouterEvent has store, drop {
    domain: u32,
    router: vector<u8>
  }

  // create events
  public fun new_enroll_remote_router_event(
    domain: u32,
    router: vector<u8>
  ): EnrollRemoteRouterEvent {
    EnrollRemoteRouterEvent { domain, router }
  }

}