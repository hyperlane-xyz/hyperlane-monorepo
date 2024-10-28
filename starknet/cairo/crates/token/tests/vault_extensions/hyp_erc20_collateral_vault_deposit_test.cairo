use mocks::mock_mailbox::{IMockMailboxDispatcher, IMockMailboxDispatcherTrait};
use mocks::{test_erc20::{ITestERC20Dispatcher, ITestERC20DispatcherTrait},};
use openzeppelin::access::ownable::interface::{IOwnableDispatcher, IOwnableDispatcherTrait};
use snforge_std::{declare, ContractClassTrait, CheatTarget, start_prank, stop_prank,};
use starknet::ContractAddress;
use super::super::hyp_erc20::common::{
    Setup, TOTAL_SUPPLY, DECIMALS, ORIGIN, TRANSFER_AMT, ALICE, BOB, E18, REQUIRED_VALUE,
    DESTINATION, IHypERC20TestDispatcher, IHypERC20TestDispatcherTrait, setup,
    perform_remote_transfer_and_gas, enroll_remote_router, enroll_local_router,
    perform_remote_transfer, handle_local_transfer, mint_and_approve
};
use token::extensions::hyp_erc20_collateral_vault_deposit::{
    IHypERC20CollateralVaultDepositDispatcher, IHypERC20CollateralVaultDepositDispatcherTrait
};
use token::interfaces::ierc4626::{IERC4626Dispatcher, IERC4626DispatcherTrait};

const DUST_AMOUNT: u256 = 100_000_000_000; // E11

fn _transfer_roundtrip_and_increase_yields(
    setup: @Setup, vault: ContractAddress, transfer_amount: u256, yield_amount: u256
) {
    // Transfer from Alice to Bob
    start_prank(CheatTarget::One((*setup).primary_token.contract_address), ALICE());
    (*setup).primary_token.approve((*setup).local_token.contract_address, transfer_amount);
    stop_prank(CheatTarget::One((*setup).primary_token.contract_address));
    perform_remote_transfer(setup, 0, transfer_amount);
    // Increase vault balance, which will reduce share redeemed for the same amount
    (*setup).primary_token.mint(vault, yield_amount);
    start_prank(CheatTarget::One((*setup).remote_token.contract_address), BOB());
    (*setup)
        .remote_token
        .transfer_remote(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(BOB())
                .into(), // orginal test has Bob here as well but not sure, should it be alice
            transfer_amount,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One((*setup).remote_token.contract_address));
}

fn assert_approx_eq_abs(lhs: u256, rhs: u256, relaxation: u256) {
    let diff = if lhs >= rhs {
        lhs - rhs
    } else {
        rhs - lhs
    };
    assert!(diff <= relaxation, "Values are not approximately equal");
}

fn setup_vault() -> (Setup, IERC4626Dispatcher, IHypERC20CollateralVaultDepositDispatcher) {
    let mut setup = setup();
    let contract = declare("ERC4626Mock").unwrap();
    let mut calldata: Array<felt252> = array![];
    setup.primary_token.contract_address.serialize(ref calldata);
    let name: ByteArray = "Regular Vault";
    let symbol: ByteArray = "RV";
    name.serialize(ref calldata);
    symbol.serialize(ref calldata);
    let (vault, _) = contract.deploy(@calldata).unwrap();

    let contract = declare("HypERC20CollateralVaultDeposit").unwrap();
    let mut calldata: Array<felt252> = array![];
    setup.local_mailbox.contract_address.serialize(ref calldata);
    vault.serialize(ref calldata);
    starknet::get_contract_address().serialize(ref calldata);
    setup.noop_hook.contract_address.serialize(ref calldata);
    setup.implementation.interchain_security_module().serialize(ref calldata);
    let (implementation, _) = contract.deploy(@calldata).unwrap();
    setup.local_token = IHypERC20TestDispatcher { contract_address: implementation };
    setup
        .local_token
        .enroll_remote_router(
            DESTINATION,
            Into::<ContractAddress, felt252>::into(setup.remote_token.contract_address).into()
        );

    setup.remote_mailbox.set_default_hook(setup.noop_hook.contract_address);
    setup.remote_mailbox.set_required_hook(setup.noop_hook.contract_address);

    setup.primary_token.transfer(ALICE(), 1000 * E18);

    setup
        .remote_token
        .enroll_remote_router(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(setup.local_token.contract_address).into()
        );
    (
        setup,
        IERC4626Dispatcher { contract_address: vault },
        IHypERC20CollateralVaultDepositDispatcher { contract_address: implementation }
    )
}

fn erc4626_vault_deposit_remote_transfer_deposits_into_vault(
    mut transfer_amount: u256
) -> (Setup, IERC4626Dispatcher, IHypERC20CollateralVaultDepositDispatcher) {
    transfer_amount %= TOTAL_SUPPLY + 1;
    let (mut setup, mut vault, mut erc20_collateral_vault_deposit) = setup_vault();
    start_prank(CheatTarget::One(setup.primary_token.contract_address), ALICE());
    mint_and_approve(@setup, transfer_amount, ALICE(), setup.local_token.contract_address);
    stop_prank(CheatTarget::One(setup.primary_token.contract_address));
    // Check vault shares balance before and after transfer
    assert_eq!(vault.max_redeem(erc20_collateral_vault_deposit.contract_address), 0);
    assert_eq!(erc20_collateral_vault_deposit.get_asset_deposited(), 0);

    start_prank(CheatTarget::One(setup.primary_token.contract_address), ALICE());
    setup.primary_token.approve(setup.local_token.contract_address, transfer_amount);
    stop_prank(CheatTarget::One(setup.primary_token.contract_address));
    perform_remote_transfer(@setup, 0, transfer_amount);
    assert_approx_eq_abs(
        vault.max_redeem(erc20_collateral_vault_deposit.contract_address), transfer_amount, 1
    );
    assert_eq!(erc20_collateral_vault_deposit.get_asset_deposited(), transfer_amount);
    (setup, vault, erc20_collateral_vault_deposit)
}

#[test]
fn test_fuzz_erc4626_vault_deposit_remote_transfer_deposits_into_vault(mut transfer_amount: u256) {
    erc4626_vault_deposit_remote_transfer_deposits_into_vault(transfer_amount);
}

#[test]
fn test_fuzz_erc4626_vault_deposit_remote_transfer_withdraws_from_vault(mut transfer_amount: u256) {
    transfer_amount %= TOTAL_SUPPLY + 1;
    let (mut setup, mut vault, mut erc20_collateral_vault_deposit) = setup_vault();
    start_prank(CheatTarget::One(setup.primary_token.contract_address), ALICE());
    mint_and_approve(@setup, transfer_amount, ALICE(), setup.local_token.contract_address);
    stop_prank(CheatTarget::One(setup.primary_token.contract_address));
    _transfer_roundtrip_and_increase_yields(
        @setup, vault.contract_address, transfer_amount, DUST_AMOUNT
    );
    // Check Alice's local token balance
    let prev_balance = setup.local_token.balance_of(ALICE());
    handle_local_transfer(@setup, transfer_amount);
    let after_balance = setup.local_token.balance_of(ALICE());
    assert_eq!(after_balance, prev_balance + transfer_amount);
    assert_eq!(erc20_collateral_vault_deposit.get_asset_deposited(), 0);
}

#[test]
fn test_fuzz_erc4626_vault_deposit_remote_transfer_withdraw_less_shares(mut reward_amount: u256) {
    reward_amount %= TOTAL_SUPPLY + 1;
    if reward_amount < DUST_AMOUNT {
        reward_amount += DUST_AMOUNT;
    }
    let (mut setup, mut vault, mut erc20_collateral_vault_deposit) = setup_vault();
    _transfer_roundtrip_and_increase_yields(
        @setup, vault.contract_address, TRANSFER_AMT, reward_amount
    );
    // Check Alice's local token balance
    let prev_balance = setup.local_token.balance_of(ALICE());
    handle_local_transfer(@setup, TRANSFER_AMT);
    let after_balance = setup.local_token.balance_of(ALICE());
    assert_eq!(after_balance, prev_balance + TRANSFER_AMT);
    // Has leftover shares, but no assets deposited]
    assert_eq!(erc20_collateral_vault_deposit.get_asset_deposited(), 0);
    assert_gt!(vault.max_redeem(erc20_collateral_vault_deposit.contract_address), 0);
}

#[test]
#[should_panic]
fn test_fuzz_erc4626_vault_deposit_remote_transfer_sweep_revert_non_owner(mut reward_amount: u256) {
    reward_amount %= TOTAL_SUPPLY + 1;
    if reward_amount < DUST_AMOUNT {
        reward_amount += DUST_AMOUNT;
    }
    let (mut setup, mut vault, mut erc20_collateral_vault_deposit) = setup_vault();
    _transfer_roundtrip_and_increase_yields(
        @setup, vault.contract_address, TRANSFER_AMT, reward_amount
    );
    start_prank(CheatTarget::One(erc20_collateral_vault_deposit.contract_address), BOB());
    erc20_collateral_vault_deposit.sweep();
    stop_prank(CheatTarget::One(erc20_collateral_vault_deposit.contract_address));
}

#[test]
fn test_fuzz_erc4626_vault_deposit_remote_transfer_sweep_no_excess_shares(
    mut transfer_amount: u256
) {
    let (mut setup, _, mut erc20_collateral_vault_deposit) =
        erc4626_vault_deposit_remote_transfer_deposits_into_vault(
        transfer_amount
    );
    let owner = IOwnableDispatcher {
        contract_address: erc20_collateral_vault_deposit.contract_address
    }
        .owner();
    let owner_balance_prev = setup.primary_token.balance_of(owner);
    erc20_collateral_vault_deposit.sweep();
    let owner_balance_after = setup.primary_token.balance_of(owner);
    assert_eq!(owner_balance_prev, owner_balance_after);
}

#[test]
fn test_erc4626_vault_deposit_remote_transfer_sweep_excess_shares_12312(mut reward_amount: u256) {
    reward_amount %= TOTAL_SUPPLY + 1;
    if reward_amount < DUST_AMOUNT {
        reward_amount += DUST_AMOUNT;
    }
    let (mut setup, mut vault, mut erc20_collateral_vault_deposit) = setup_vault();
    _transfer_roundtrip_and_increase_yields(
        @setup, vault.contract_address, TRANSFER_AMT, reward_amount
    );
    handle_local_transfer(@setup, TRANSFER_AMT);
    let owner = IOwnableDispatcher {
        contract_address: erc20_collateral_vault_deposit.contract_address
    }
        .owner();
    let owner_balance_prev = setup.primary_token.balance_of(owner);
    let excess_amount = vault.max_redeem(erc20_collateral_vault_deposit.contract_address);
    erc20_collateral_vault_deposit.sweep();
    let owner_balance_after = setup.primary_token.balance_of(owner);
    assert_gt!(owner_balance_after, owner_balance_prev + excess_amount);
}

#[test]
fn test_erc4626_vault_deposit_remote_transfer_sweep_excess_shares_multiple_deposit(
    mut reward_amount: u256
) {
    reward_amount %= TOTAL_SUPPLY + 1;
    if reward_amount < DUST_AMOUNT {
        reward_amount += DUST_AMOUNT;
    }
    let (mut setup, mut vault, mut erc20_collateral_vault_deposit) = setup_vault();
    _transfer_roundtrip_and_increase_yields(
        @setup, vault.contract_address, TRANSFER_AMT, reward_amount
    );
    handle_local_transfer(@setup, TRANSFER_AMT);

    let owner = IOwnableDispatcher {
        contract_address: erc20_collateral_vault_deposit.contract_address
    }
        .owner();
    let owner_balance_prev = setup.primary_token.balance_of(owner);
    let excess_amount = vault.max_redeem(erc20_collateral_vault_deposit.contract_address);
    // Deposit again for Alice
    start_prank(CheatTarget::One(setup.primary_token.contract_address), ALICE());
    setup.primary_token.approve(setup.local_token.contract_address, TRANSFER_AMT);
    stop_prank(CheatTarget::One(setup.primary_token.contract_address));
    perform_remote_transfer(@setup, 0, TRANSFER_AMT);
    // Sweep and check
    erc20_collateral_vault_deposit.sweep();
    let owner_balance_after = setup.primary_token.balance_of(owner);
    assert_gt!(owner_balance_after, owner_balance_prev + excess_amount);
}

// NOTE: Not applicable on Starknet
fn test_benchmark_overhead_gas_usage() {}
