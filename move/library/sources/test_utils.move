#[test_only]
module hp_library::test_utils {
  use std::vector;
  use std::signer;
  use std::string::{Self, String};

  use aptos_framework::coin::{Self, MintCapability, BurnCapability};
  use aptos_framework::aptos_account; 
  use aptos_framework::aptos_coin::{Self, AptosCoin}; 

  struct AptosCoinCap has key {
    mint_cap: MintCapability<AptosCoin>,
    burn_cap: BurnCapability<AptosCoin>,
  }

  public fun setup(aptos: &signer, core_resources: &signer, addresses: vector<address>) {
    // init the aptos_coin and give merkly_root the mint ability.
    let (burn_cap, mint_cap) = aptos_coin::initialize_for_test(aptos);

    aptos_account::create_account(signer::address_of(core_resources));
    let coins = coin::mint<AptosCoin>(
        18446744073709551615,
        &mint_cap,
    );
    coin::deposit<AptosCoin>(signer::address_of(core_resources), coins);

    let i = 0;
    while (i < vector::length(&addresses)) {
        aptos_account::transfer(core_resources, *vector::borrow(&addresses, i), 100000000000);
        i = i + 1;
    };

    // gracefully shutdown
    move_to(core_resources, AptosCoinCap {
        mint_cap,
        burn_cap
    });
  }

}