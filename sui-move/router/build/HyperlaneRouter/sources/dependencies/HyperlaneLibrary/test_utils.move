#[test_only]
module hp_library::test_utils {
  
  use sui::test_scenario::{Self as test, Scenario};

  public fun scenario(): Scenario { test::begin(@0x1) }
}