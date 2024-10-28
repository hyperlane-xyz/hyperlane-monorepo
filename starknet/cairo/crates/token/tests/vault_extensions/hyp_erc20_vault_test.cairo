use contracts::interfaces::{IMailboxClientDispatcher, IMailboxClientDispatcherTrait};
use mocks::erc4626_yield_sharing_mock::{
    IERC4626YieldSharingDispatcher, IERC4626YieldSharingDispatcherTrait
};
use mocks::mock_mailbox::{IMockMailboxDispatcher, IMockMailboxDispatcherTrait};
use mocks::{test_erc20::{ITestERC20Dispatcher, ITestERC20DispatcherTrait},};
use openzeppelin::access::ownable::interface::{IOwnableDispatcher, IOwnableDispatcherTrait};
use snforge_std::{declare, CheatTarget, start_prank, stop_prank, ContractClass, ContractClassTrait};
use starknet::ContractAddress;
use super::super::hyp_erc20::common::{
    Setup, TOTAL_SUPPLY, DECIMALS, ORIGIN, TRANSFER_AMT, ALICE, BOB, DANIEL, CAROL, E18,
    REQUIRED_VALUE, DESTINATION, IHypERC20TestDispatcher, IHypERC20TestDispatcherTrait,
    perform_remote_transfer_and_gas, enroll_remote_router, enroll_local_router,
    perform_remote_transfer, handle_local_transfer, mint_and_approve, connect_routers
};
use super::super::hyp_erc20::common;
use token::components::token_router::{ITokenRouterDispatcher, ITokenRouterDispatcherTrait};
use token::extensions::{
    hyp_erc20_vault_collateral::{
        IHypErc20VaultCollateralDispatcher, IHypErc20VaultCollateralDispatcherTrait
    },
    hyp_erc20_vault::{IHypErc20VaultDispatcher, IHypErc20VaultDispatcherTrait}
};
use token::interfaces::ierc4626::{IERC4626Dispatcher, IERC4626DispatcherTrait};

const PEER_DESTINATION: u32 = 13;
const YIELD: u256 = 5 * E18;
const YIELD_FEES: u256 = E18 / 10; // E17
const E14: u256 = 100_000_000_000_000;
const E10: u256 = 10_000_000_000;

fn setup_vault() -> (
    Setup,
    IHypErc20VaultCollateralDispatcher,
    IERC4626Dispatcher,
    IERC4626Dispatcher,
    IERC4626YieldSharingDispatcher,
    IMockMailboxDispatcher
) {
    let mut setup = common::setup();
    // multi-synthetic setup
    let default_ism = setup.implementation.interchain_security_module();

    let (peer_mailbox, _) = setup
        .mock_mailbox_contract
        .deploy(
            @array![
                PEER_DESTINATION.into(),
                default_ism.into(),
                setup.noop_hook.contract_address.into(),
                setup.eth_token.contract_address.into()
            ]
        )
        .unwrap();

    let peer_mailbox_dispatcher = IMockMailboxDispatcher { contract_address: peer_mailbox };
    setup.local_mailbox.add_remote_mail_box(PEER_DESTINATION, peer_mailbox);
    setup.remote_mailbox.add_remote_mail_box(PEER_DESTINATION, peer_mailbox);
    peer_mailbox_dispatcher.add_remote_mail_box(DESTINATION, setup.remote_mailbox.contract_address);
    peer_mailbox_dispatcher.add_remote_mail_box(ORIGIN, setup.local_mailbox.contract_address);

    let contract = declare("ERC4626YieldSharingMock").unwrap();
    let mut calldata: Array<felt252> = array![];
    setup.primary_token.contract_address.serialize(ref calldata);
    let name: ByteArray = "Regular Vault";
    let symbol: ByteArray = "RV";
    name.serialize(ref calldata);
    symbol.serialize(ref calldata);
    YIELD_FEES.serialize(ref calldata);
    start_prank(CheatTarget::All, DANIEL());
    let (vault, _) = contract.deploy(@calldata).unwrap();
    stop_prank(CheatTarget::All);

    let contract = declare("HypErc20VaultCollateral").unwrap();
    let (local_token, _) = contract
        .deploy(
            @array![
                setup.local_mailbox.contract_address.into(),
                vault.into(),
                starknet::get_contract_address().into(),
                setup.noop_hook.contract_address.into(),
                default_ism.into()
            ]
        )
        .unwrap();

    let dummy_name: ByteArray = "Dummy Name";
    let dummy_symbol: ByteArray = "DUM";
    let contract = declare("HypErc20Vault").unwrap();
    let mut calldata: Array<felt252> = array![];
    setup.primary_token.decimals().serialize(ref calldata);
    setup.remote_mailbox.contract_address.serialize(ref calldata);
    TOTAL_SUPPLY.serialize(ref calldata);
    dummy_name.serialize(ref calldata);
    dummy_symbol.serialize(ref calldata);
    setup.local_mailbox.get_local_domain().serialize(ref calldata);
    setup.primary_token.contract_address.serialize(ref calldata);
    starknet::get_contract_address().serialize(ref calldata);
    setup.noop_hook.contract_address.serialize(ref calldata);
    default_ism.serialize(ref calldata);

    let (remote_token, _) = contract.deploy(@calldata).unwrap();

    let mut calldata: Array<felt252> = array![];
    setup.primary_token.decimals().serialize(ref calldata);
    peer_mailbox.serialize(ref calldata);
    TOTAL_SUPPLY.serialize(ref calldata);
    dummy_name.serialize(ref calldata);
    dummy_symbol.serialize(ref calldata);
    setup.local_mailbox.get_local_domain().serialize(ref calldata);
    setup.primary_token.contract_address.serialize(ref calldata);
    starknet::get_contract_address().serialize(ref calldata);
    setup.noop_hook.contract_address.serialize(ref calldata);
    default_ism.serialize(ref calldata);
    let (peer_token, _) = contract.deploy(@calldata).unwrap();

    let local_rebasing_token = IHypErc20VaultCollateralDispatcher { contract_address: local_token };
    let remote_rebasing_token = IERC4626Dispatcher { contract_address: remote_token };
    let peer_rebasing_token = IERC4626Dispatcher { contract_address: peer_token };
    setup.primary_token.transfer(ALICE(), 1000 * E18);
    let domains = array![ORIGIN, DESTINATION, PEER_DESTINATION];
    let addresses_u256 = array![
        Into::<ContractAddress, felt252>::into(local_token).into(),
        Into::<ContractAddress, felt252>::into(remote_token).into(),
        Into::<ContractAddress, felt252>::into(peer_token).into()
    ];

    connect_routers(@setup, domains.span(), addresses_u256.span());

    (
        setup,
        local_rebasing_token,
        remote_rebasing_token,
        peer_rebasing_token,
        IERC4626YieldSharingDispatcher { contract_address: vault },
        peer_mailbox_dispatcher
    )
}

#[test]
fn test_collateral_domain() {
    let (_, local_rebasing_token, remote_rebasing_token, _, _, _) = setup_vault();
    assert_eq!(
        IHypErc20VaultDispatcher { contract_address: remote_rebasing_token.contract_address }
            .get_collateral_domain(),
        IMailboxClientDispatcher { contract_address: local_rebasing_token.contract_address }
            .get_local_domain()
    );
}

#[test]
fn test_remote_transfer_rebase_after() {
    let (
        mut setup, mut local_rebasing_token, remote_rebasing_token, _, mut yield_sharing_vault, _
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    _accrue_yield(@setup, yield_sharing_vault.contract_address);

    local_rebasing_token.rebase(DESTINATION, 0);

    setup.remote_mailbox.process_next_inbound_message();

    assert_eq!(
        remote_rebasing_token.balance_of(BOB()),
        TRANSFER_AMT + _discounted_yield(yield_sharing_vault)
    );
}

#[test]
fn test_rebase_with_transfer() {
    let (
        mut setup, mut local_rebasing_token, remote_rebasing_token, _, mut yield_sharing_vault, _
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    _accrue_yield(@setup, yield_sharing_vault.contract_address);

    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );

    assert_approx_eq_rel(
        remote_rebasing_token.balance_of(BOB()),
        2 * TRANSFER_AMT + _discounted_yield(yield_sharing_vault),
        E14,
    );
}

#[test]
fn test_synthetic_transfers_with_rebase() {
    let (
        mut setup, mut local_rebasing_token, remote_rebasing_token, _, mut yield_sharing_vault, _
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    _accrue_yield(@setup, yield_sharing_vault.contract_address);

    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    start_prank(CheatTarget::All, BOB());
    remote_rebasing_token.transfer(CAROL(), TRANSFER_AMT);
    stop_prank(CheatTarget::All);
    assert_approx_eq_rel(
        remote_rebasing_token.balance_of(BOB()),
        TRANSFER_AMT + _discounted_yield(yield_sharing_vault),
        E14,
    );
    assert_approx_eq_rel(remote_rebasing_token.balance_of(CAROL()), TRANSFER_AMT, E14,);
}

#[test]
fn test_withdrawal_without_yield() {
    let (mut setup, mut local_rebasing_token, remote_rebasing_token, _, _, _) = setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);
    start_prank(CheatTarget::One(remote_rebasing_token.contract_address), BOB());
    ITokenRouterDispatcher { contract_address: remote_rebasing_token.contract_address }
        .transfer_remote(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(BOB()).into(),
            TRANSFER_AMT,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(remote_rebasing_token.contract_address));

    setup.local_mailbox.process_next_inbound_message();
    assert_eq!(setup.primary_token.balance_of(BOB()), TRANSFER_AMT);
}

#[test]
fn test_withdrawal_with_yield() {
    let (
        mut setup, mut local_rebasing_token, remote_rebasing_token, _, mut yield_sharing_vault, _
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    _accrue_yield(@setup, yield_sharing_vault.contract_address);

    start_prank(CheatTarget::One(remote_rebasing_token.contract_address), BOB());
    ITokenRouterDispatcher { contract_address: remote_rebasing_token.contract_address }
        .transfer_remote(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(BOB()).into(),
            TRANSFER_AMT,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(remote_rebasing_token.contract_address));

    setup.local_mailbox.process_next_inbound_message();
    // BOB gets the yield even though it didn't rebase
    let bob_balance = setup.primary_token.balance_of(BOB());
    let expected_balance = TRANSFER_AMT + _discounted_yield(yield_sharing_vault);
    assert_approx_eq_rel(bob_balance, expected_balance, E14);
    assert_lt!(bob_balance, expected_balance, "Transfer remote should round down");
    assert_eq!(yield_sharing_vault.accumulated_fees(), YIELD / 10);
}

#[test]
fn test_withdrawal_after_yield() {
    let (
        mut setup, mut local_rebasing_token, remote_rebasing_token, _, mut yield_sharing_vault, _
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    _accrue_yield(@setup, yield_sharing_vault.contract_address);

    local_rebasing_token.rebase(DESTINATION, 0);
    setup.remote_mailbox.process_next_inbound_message();

    // Use balance here since it might be off by <1bp
    let bob_balance_remote = remote_rebasing_token.balance_of(BOB());

    start_prank(CheatTarget::One(remote_rebasing_token.contract_address), BOB());
    ITokenRouterDispatcher { contract_address: remote_rebasing_token.contract_address }
        .transfer_remote(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(BOB()).into(),
            bob_balance_remote,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(remote_rebasing_token.contract_address));
    setup.local_mailbox.process_next_inbound_message();
    let bob_balance_primary = setup.primary_token.balance_of(BOB());
    assert_approx_eq_rel(
        bob_balance_primary, TRANSFER_AMT + _discounted_yield(yield_sharing_vault), E14
    );
    assert_eq!(yield_sharing_vault.accumulated_fees(), YIELD / 10);
}

#[test]
fn test_withdrawal_in_flight() {
    let (
        mut setup, mut local_rebasing_token, remote_rebasing_token, _, mut yield_sharing_vault, _
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    setup.primary_token.mint(CAROL(), TRANSFER_AMT);
    start_prank(CheatTarget::One(setup.primary_token.contract_address), CAROL());
    setup.primary_token.approve(local_rebasing_token.contract_address, TRANSFER_AMT);
    stop_prank(CheatTarget::One(setup.primary_token.contract_address));
    start_prank(CheatTarget::One(local_rebasing_token.contract_address), CAROL());
    ITokenRouterDispatcher { contract_address: local_rebasing_token.contract_address }
        .transfer_remote(
            DESTINATION,
            Into::<ContractAddress, felt252>::into(CAROL()).into(),
            TRANSFER_AMT,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(local_rebasing_token.contract_address));

    setup.remote_mailbox.process_next_inbound_message();

    _accrue_yield(@setup, yield_sharing_vault.contract_address);
    _accrue_yield(@setup, yield_sharing_vault.contract_address); // earning 2x yield to be split

    local_rebasing_token.rebase(DESTINATION, 0);
    start_prank(CheatTarget::One(remote_rebasing_token.contract_address), CAROL());
    ITokenRouterDispatcher { contract_address: remote_rebasing_token.contract_address }
        .transfer_remote(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(CAROL()).into(),
            TRANSFER_AMT,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(remote_rebasing_token.contract_address));

    setup.local_mailbox.process_next_inbound_message();

    let claimable_fees = IERC4626YieldSharingDispatcher {
        contract_address: yield_sharing_vault.contract_address
    }
        .get_claimable_fees();
    let carol_balance_primary = setup.primary_token.balance_of(CAROL());
    assert_approx_eq_rel(carol_balance_primary, TRANSFER_AMT + YIELD - (claimable_fees / 2), E14);

    // until we process the rebase, the yield is not added on the remote
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);
    setup.remote_mailbox.process_next_inbound_message();
    assert_approx_eq_rel(
        remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT + YIELD - (claimable_fees / 2), E14
    );

    assert_eq!(yield_sharing_vault.accumulated_fees(), YIELD / 5); // 0.1 * 2 * yield
}

#[test]
fn test_withdrawal_after_drawdown() {
    let (
        mut setup, mut local_rebasing_token, remote_rebasing_token, _, mut yield_sharing_vault, _
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    // decrease collateral in vault by 10%
    let drawdown = 5 * E18;
    start_prank(
        CheatTarget::One(setup.primary_token.contract_address), yield_sharing_vault.contract_address
    );
    setup.primary_token.burn(drawdown);
    stop_prank(CheatTarget::One(setup.primary_token.contract_address));

    local_rebasing_token.rebase(DESTINATION, 0);
    setup.remote_mailbox.process_next_inbound_message();

    // Use balance here since it might be off by <1bp
    let bob_balance_remote = remote_rebasing_token.balance_of(BOB());
    start_prank(CheatTarget::One(remote_rebasing_token.contract_address), BOB());
    ITokenRouterDispatcher { contract_address: remote_rebasing_token.contract_address }
        .transfer_remote(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(BOB()).into(),
            bob_balance_remote,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(remote_rebasing_token.contract_address));
    setup.local_mailbox.process_next_inbound_message();
    assert_approx_eq_rel(setup.primary_token.balance_of(BOB()), TRANSFER_AMT - drawdown, E14);
}

#[test]
fn test_exchange_rate_set_only_by_collateral() {
    let (
        mut setup,
        mut local_rebasing_token,
        remote_rebasing_token,
        peer_rebasing_token,
        mut yield_sharing_vault,
        mut peer_mailbox
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    _accrue_yield(@setup, yield_sharing_vault.contract_address);

    local_rebasing_token.rebase(DESTINATION, 0);
    setup.remote_mailbox.process_next_inbound_message();

    start_prank(CheatTarget::One(remote_rebasing_token.contract_address), BOB());
    ITokenRouterDispatcher { contract_address: remote_rebasing_token.contract_address }
        .transfer_remote(
            PEER_DESTINATION,
            Into::<ContractAddress, felt252>::into(BOB()).into(),
            TRANSFER_AMT,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(remote_rebasing_token.contract_address));
    peer_mailbox.process_next_inbound_message();

    assert_eq!(
        IHypErc20VaultDispatcher { contract_address: remote_rebasing_token.contract_address }
            .get_exchange_rate(),
        10_450_000_000
    ); // 5 * 0.9 = 4.5% yield
    assert_eq!(
        IHypErc20VaultDispatcher { contract_address: peer_rebasing_token.contract_address }
            .get_exchange_rate(),
        E10
    ); // asserting that transfers by the synthetic variant don't impact the exchang rate

    local_rebasing_token.rebase(PEER_DESTINATION, 0);
    peer_mailbox.process_next_inbound_message();

    assert_eq!(
        IHypErc20VaultDispatcher { contract_address: peer_rebasing_token.contract_address }
            .get_exchange_rate(),
        10_450_000_000
    ); // asserting that the exchange rate is set finally by the collateral variant
}

#[test]
fn test_cyclic_transfers() {
    // ALICE: local -> remote(BOB)
    let (
        mut setup,
        mut local_rebasing_token,
        remote_rebasing_token,
        peer_rebasing_token,
        mut yield_sharing_vault,
        mut peer_mailbox
    ) =
        setup_vault();
    _perform_remote_transfer_without_expectation(
        @setup, local_rebasing_token.contract_address, 0, TRANSFER_AMT
    );
    assert_eq!(remote_rebasing_token.balance_of(BOB()), TRANSFER_AMT);

    _accrue_yield(@setup, yield_sharing_vault.contract_address);

    local_rebasing_token.rebase(DESTINATION, 0); // yield is added
    setup.remote_mailbox.process_next_inbound_message();
    // BOB: remote -> peer(BOB) (yield is leftover)
    start_prank(CheatTarget::One(remote_rebasing_token.contract_address), BOB());
    ITokenRouterDispatcher { contract_address: remote_rebasing_token.contract_address }
        .transfer_remote(
            PEER_DESTINATION,
            Into::<ContractAddress, felt252>::into(BOB()).into(),
            TRANSFER_AMT,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(remote_rebasing_token.contract_address));
    peer_mailbox.process_next_inbound_message();

    local_rebasing_token.rebase(PEER_DESTINATION, 0);
    peer_mailbox.process_next_inbound_message();

    // BOB: peer -> local(CAROL)
    start_prank(CheatTarget::One(peer_rebasing_token.contract_address), BOB());
    ITokenRouterDispatcher { contract_address: peer_rebasing_token.contract_address }
        .transfer_remote(
            ORIGIN,
            Into::<ContractAddress, felt252>::into(CAROL()).into(),
            TRANSFER_AMT,
            0,
            Option::None,
            Option::None
        );
    stop_prank(CheatTarget::One(peer_rebasing_token.contract_address));
    setup.local_mailbox.process_next_inbound_message();

    assert_approx_eq_rel(
        remote_rebasing_token.balance_of(BOB()), _discounted_yield(yield_sharing_vault), E14
    );
    assert_eq!(peer_rebasing_token.balance_of(BOB()), 0);
    assert_approx_eq_rel(setup.primary_token.balance_of(CAROL()), TRANSFER_AMT, E14);
}

// skipped in solidity version as well
//#[test]
//fn test_transfer_with_hook_specified() {
//    assert(true, '');
//}

// NOTE: Not applicable on Starknet
fn test_benchmark_overhead_gas_usage() {}

///////////////////////////////////////////////////////
///             Helper functions
///////////////////////////////////////////////////////

/// ALICE: local -> remote(BOB)
fn _perform_remote_transfer_without_expectation(
    setup: @Setup, local_token: ContractAddress, msg_value: u256, amount: u256
) {
    start_prank(CheatTarget::One((*setup).primary_token.contract_address), ALICE());
    (*setup).primary_token.approve(local_token, TRANSFER_AMT);
    stop_prank(CheatTarget::One((*setup).primary_token.contract_address));

    start_prank(CheatTarget::One(local_token), ALICE());
    ITokenRouterDispatcher { contract_address: local_token }
        .transfer_remote(
            DESTINATION,
            Into::<ContractAddress, felt252>::into(BOB()).into(),
            amount,
            msg_value,
            Option::None,
            Option::None
        );

    stop_prank(CheatTarget::One(local_token));

    (*setup).remote_mailbox.process_next_inbound_message();
}

fn _accrue_yield(setup: @Setup, vault: ContractAddress) {
    (*setup).primary_token.mint(vault, YIELD);
}

fn _discounted_yield(vault: IERC4626YieldSharingDispatcher) -> u256 {
    YIELD - vault.get_claimable_fees()
}

/// see {https://github.com/foundry-rs/foundry/blob/e16a75b615f812db6127ea22e23c3ee65504c1f1/crates/cheatcodes/src/test/assert.rs#L533}
fn assert_approx_eq_rel(lhs: u256, rhs: u256, max_delta: u256) {
    if lhs == 0 {
        if rhs == 0 {
            return;
        } else {
            panic!("eq_rel_assertion error lhs {}, rhs {}, max_delta {}", lhs, rhs, max_delta);
        }
    }

    let mut delta = if lhs > rhs {
        lhs - rhs
    } else {
        rhs - lhs
    };

    delta *= E18;
    delta /= rhs;

    if delta > max_delta {
        panic!(
            "eq_rel_assertion error lhs {}, rhs {}, max_delta {}, real_delta {}",
            lhs,
            rhs,
            max_delta,
            delta
        );
    }
}
