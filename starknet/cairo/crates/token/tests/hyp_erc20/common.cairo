use alexandria_bytes::{Bytes, BytesTrait};
use contracts::client::gas_router_component::{
    GasRouterComponent::GasRouterConfig, IGasRouterDispatcher, IGasRouterDispatcherTrait
};
use contracts::client::router_component::{IRouterDispatcher, IRouterDispatcherTrait};
use contracts::interfaces::{
    IMailboxDispatcher, IMailboxDispatcherTrait, IMessageRecipientDispatcher,
    IMessageRecipientDispatcherTrait, IMailboxClientDispatcher, IMailboxClientDispatcherTrait
};
use mocks::{
    test_post_dispatch_hook::{
        ITestPostDispatchHookDispatcher, ITestPostDispatchHookDispatcherTrait
    },
    mock_mailbox::{IMockMailboxDispatcher, IMockMailboxDispatcherTrait},
    test_erc20::{ITestERC20Dispatcher, ITestERC20DispatcherTrait},
    test_interchain_gas_payment::{
        ITestInterchainGasPaymentDispatcher, ITestInterchainGasPaymentDispatcherTrait
    },
    mock_eth::{MockEthDispatcher, MockEthDispatcherTrait}
};
use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{
    declare, ContractClassTrait, ContractClass, CheatTarget, EventSpy, EventAssertions, spy_events,
    SpyOn, start_prank, stop_prank, EventFetcher, event_name_hash
};
use starknet::ContractAddress;
use token::components::token_router::{ITokenRouterDispatcher, ITokenRouterDispatcherTrait};

pub const E18: u256 = 1_000_000_000_000_000_000;
pub const ORIGIN: u32 = 11;
pub const DESTINATION: u32 = 12;
pub const DECIMALS: u8 = 18;
pub const TOTAL_SUPPLY: u256 = 1_000_000 * E18;
pub const GAS_LIMIT: u256 = 10_000;
pub const TRANSFER_AMT: u256 = 100 * E18;
pub const REQUIRED_VALUE: u256 = 0;
pub const ZERO_SUPPLY: u256 = 0;
// const NAME: ByteArray = "HyperlaneInu";
// const SYMBOL: ByteArray = "HYP";
fn IGP() -> ContractAddress {
    starknet::contract_address_const::<'IGP'>()
}
pub fn OWNER() -> ContractAddress {
    starknet::contract_address_const::<'OWNER'>()
}
pub fn ALICE() -> ContractAddress {
    starknet::contract_address_const::<0x1>()
}
pub fn BOB() -> ContractAddress {
    starknet::contract_address_const::<0x2>()
}
pub fn CAROL() -> ContractAddress {
    starknet::contract_address_const::<0x3>()
}
pub fn DANIEL() -> ContractAddress {
    starknet::contract_address_const::<0x4>()
}
fn PROXY_ADMIN() -> ContractAddress {
    starknet::contract_address_const::<0x37>()
}

pub fn NAME() -> ByteArray {
    "HyperlaneInu"
}
pub fn SYMBOL() -> ByteArray {
    "HYP"
}

#[starknet::interface]
pub trait IHypERC20Test<TContractState> {
    // Collateral
    fn transfer_from_sender_hook(ref self: TContractState, amount_or_id: u256) -> Bytes;
    fn transfer_to_hook(
        ref self: TContractState, recipient: ContractAddress, amount: u256, metadata: Bytes
    ) -> bool;
    fn get_wrapped_token(self: @TContractState) -> ContractAddress;
    // MailboxClient
    fn set_hook(ref self: TContractState, _hook: ContractAddress);
    fn set_interchain_security_module(ref self: TContractState, _module: ContractAddress);
    fn get_hook(self: @TContractState) -> ContractAddress;
    fn get_local_domain(self: @TContractState) -> u32;
    fn interchain_security_module(self: @TContractState) -> ContractAddress;
    // Router
    fn enroll_remote_router(ref self: TContractState, domain: u32, router: u256);
    fn enroll_remote_routers(ref self: TContractState, domains: Array<u32>, addresses: Array<u256>);
    fn unenroll_remote_router(ref self: TContractState, domain: u32);
    fn unenroll_remote_routers(ref self: TContractState, domains: Array<u32>);
    fn handle(ref self: TContractState, origin: u32, sender: u256, message: Bytes);
    fn domains(self: @TContractState) -> Array<u32>;
    fn routers(self: @TContractState, domain: u32) -> u256;
    // GasRouter
    fn set_destination_gas(
        ref self: TContractState,
        gas_configs: Option<Array<GasRouterConfig>>,
        domain: Option<u32>,
        gas: Option<u256>
    );
    fn quote_gas_payment(self: @TContractState, destination_domain: u32) -> u256;
    // TokenRouter
    fn transfer_remote(
        ref self: TContractState,
        destination: u32,
        recipient: u256,
        amount_or_id: u256,
        value: u256,
        hook_metadata: Option<Bytes>,
        hook: Option<ContractAddress>
    ) -> u256;
    // ERC20
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256
    ) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
    // HypERC20
    fn decimals(self: @TContractState) -> u8;
}

#[derive(Copy, Drop)]
pub struct Setup {
    pub noop_hook: ITestPostDispatchHookDispatcher,
    pub local_mailbox: IMockMailboxDispatcher,
    pub remote_mailbox: IMockMailboxDispatcher,
    pub primary_token: ITestERC20Dispatcher,
    pub implementation: IHypERC20TestDispatcher,
    pub remote_token: IHypERC20TestDispatcher,
    pub local_token: IHypERC20TestDispatcher,
    pub igp: ITestInterchainGasPaymentDispatcher,
    pub erc20_token: ITestERC20Dispatcher,
    pub eth_token: MockEthDispatcher,
    pub mock_mailbox_contract: ContractClass
}

pub fn setup() -> Setup {
    let contract = declare("TestISM").unwrap();
    let (default_ism, _) = contract.deploy(@array![]).unwrap();

    let contract = declare("TestPostDispatchHook").unwrap();
    let (noop_hook, _) = contract.deploy(@array![]).unwrap();
    let noop_hook = ITestPostDispatchHookDispatcher { contract_address: noop_hook };

    let contract = declare("Ether").unwrap();
    let mut calldata: Array<felt252> = array![];
    starknet::get_contract_address().serialize(ref calldata);
    let (eth_address, _) = contract.deploy(@calldata).unwrap();
    let eth_token = MockEthDispatcher { contract_address: eth_address };
    eth_token.mint(ALICE(), 10 * E18);

    let mock_mailbox_contract = declare("MockMailbox").unwrap();
    let (local_mailbox, _) = mock_mailbox_contract
        .deploy(
            @array![
                ORIGIN.into(),
                default_ism.into(),
                noop_hook.contract_address.into(),
                eth_address.into()
            ]
        )
        .unwrap();
    let local_mailbox = IMockMailboxDispatcher { contract_address: local_mailbox };

    let (remote_mailbox, _) = mock_mailbox_contract
        .deploy(
            @array![
                DESTINATION.into(),
                default_ism.into(),
                noop_hook.contract_address.into(),
                eth_address.into()
            ]
        )
        .unwrap();
    let remote_mailbox = IMockMailboxDispatcher { contract_address: remote_mailbox };

    local_mailbox.add_remote_mail_box(DESTINATION, remote_mailbox.contract_address);
    remote_mailbox.add_remote_mail_box(ORIGIN, local_mailbox.contract_address);

    local_mailbox.set_default_hook(noop_hook.contract_address);
    local_mailbox.set_required_hook(noop_hook.contract_address);
    remote_mailbox.set_default_hook(noop_hook.contract_address);
    remote_mailbox.set_required_hook(noop_hook.contract_address);

    let contract = declare("TestERC20").unwrap();
    let mut calldata: Array<felt252> = array![];
    TOTAL_SUPPLY.serialize(ref calldata);
    DECIMALS.serialize(ref calldata);
    let (primary_token, _) = contract.deploy(@calldata).unwrap();
    let primary_token = ITestERC20Dispatcher { contract_address: primary_token };

    let (erc20_token, _) = contract.deploy(@calldata).unwrap();
    let erc20_token = ITestERC20Dispatcher { contract_address: erc20_token };

    let hyp_erc20_contract = declare("HypErc20").unwrap();
    let mut calldata: Array<felt252> = array![];
    DECIMALS.serialize(ref calldata);
    remote_mailbox.contract_address.serialize(ref calldata);
    TOTAL_SUPPLY.serialize(ref calldata);
    NAME().serialize(ref calldata);
    SYMBOL().serialize(ref calldata);
    noop_hook.contract_address.serialize(ref calldata);
    default_ism.serialize(ref calldata);
    OWNER().serialize(ref calldata);
    let (implementation, _) = hyp_erc20_contract.deploy(@calldata).unwrap();
    let implementation = IHypERC20TestDispatcher { contract_address: implementation };

    let contract = declare("TestInterchainGasPayment").unwrap();
    let (igp, _) = contract.deploy(@array![]).unwrap();
    let igp = ITestInterchainGasPaymentDispatcher { contract_address: igp };

    let mut calldata: Array<felt252> = array![];
    DECIMALS.serialize(ref calldata);
    remote_mailbox.contract_address.serialize(ref calldata);
    TOTAL_SUPPLY.serialize(ref calldata);
    NAME().serialize(ref calldata);
    SYMBOL().serialize(ref calldata);
    noop_hook.contract_address.serialize(ref calldata);
    igp.contract_address.serialize(ref calldata);
    starknet::get_contract_address().serialize(ref calldata);
    let (remote_token, _) = hyp_erc20_contract.deploy(@calldata).unwrap();
    let remote_token = IHypERC20TestDispatcher { contract_address: remote_token };

    let mut calldata: Array<felt252> = array![];
    DECIMALS.serialize(ref calldata);
    local_mailbox.contract_address.serialize(ref calldata);
    TOTAL_SUPPLY.serialize(ref calldata);
    NAME().serialize(ref calldata);
    SYMBOL().serialize(ref calldata);
    noop_hook.contract_address.serialize(ref calldata);
    igp.contract_address.serialize(ref calldata);
    starknet::get_contract_address().serialize(ref calldata);
    let (local_token, _) = hyp_erc20_contract.deploy(@calldata).unwrap();
    let local_token = IHypERC20TestDispatcher { contract_address: local_token };

    let local_token_address: felt252 = local_token.contract_address.into();
    remote_token.enroll_remote_router(ORIGIN, local_token_address.into());

    local_token.transfer(ALICE(), 1000 * E18);

    Setup {
        noop_hook,
        local_mailbox,
        remote_mailbox,
        primary_token,
        implementation,
        remote_token,
        local_token,
        igp,
        erc20_token,
        eth_token,
        mock_mailbox_contract
    }
}

pub fn enroll_local_router(setup: @Setup) {
    let remote_token_address: felt252 = (*setup).remote_token.contract_address.into();
    (*setup).local_token.enroll_remote_router(DESTINATION, remote_token_address.into());
}

pub fn enroll_remote_router(setup: @Setup) {
    let local_token_address: felt252 = (*setup).local_token.contract_address.into();
    (*setup).remote_token.enroll_remote_router(ORIGIN, local_token_address.into());
}

pub fn connect_routers(setup: @Setup, domains: Span<u32>, addresses: Span<u256>) {
    let n = domains.len();

    let mut i: usize = 0;
    while i < n {
        let mut complement_domains: Array<u32> = array![];
        let mut complement_routers: Array<u256> = array![];

        let mut k: usize = 0;
        while k < n {
            if k != i {
                complement_domains.append(*domains.at(k));
                complement_routers.append(*addresses.at(k));
            }
            k += 1;
        };
        let address_felt: felt252 = (*addresses.at(i)).try_into().unwrap();
        let contract_address: ContractAddress = address_felt.try_into().unwrap();
        let router = IRouterDispatcher { contract_address };
        router.enroll_remote_routers(complement_domains, complement_routers);
        i += 1;
    };
}

pub fn expect_remote_balance(setup: @Setup, user: ContractAddress, balance: u256) {
    let remote_token = IERC20Dispatcher {
        contract_address: (*setup).remote_token.contract_address
    };
    assert_eq!(remote_token.balance_of(user), balance);
}

pub fn process_transfers(setup: @Setup, recipient: ContractAddress, amount: u256) {
    start_prank(
        CheatTarget::One((*setup).remote_token.contract_address),
        (*setup).remote_mailbox.contract_address
    );
    let mut message = BytesTrait::new_empty();
    message.append_address(recipient);
    message.append_u256(amount);
    let address_felt: felt252 = (*setup).local_token.contract_address.into();
    let local_token_address: u256 = address_felt.into();
    (*setup).remote_token.handle(ORIGIN, local_token_address, message);
    stop_prank(CheatTarget::One((*setup).remote_token.contract_address));
}

pub fn handle_local_transfer(setup: @Setup, transfer_amount: u256) {
    start_prank(
        CheatTarget::One((*setup).local_token.contract_address),
        (*setup).local_mailbox.contract_address
    );
    let mut message = BytesTrait::new_empty();
    message.append_address(ALICE());
    message.append_u256(transfer_amount);

    let address_felt: felt252 = (*setup).remote_token.contract_address.into();
    let contract_address: u256 = address_felt.into();
    (*setup).local_token.handle(DESTINATION, contract_address, message);
    stop_prank(CheatTarget::One((*setup).local_token.contract_address));
}

pub fn mint_and_approve(
    setup: @Setup, amount: u256, mint_to: ContractAddress, approve_to: ContractAddress
) {
    (*setup).primary_token.mint(mint_to, amount);
    (*setup).primary_token.approve(approve_to, amount);
}

pub fn set_custom_gas_config(setup: @Setup) {
    (*setup).local_token.set_hook((*setup).igp.contract_address);
    let config = array![GasRouterConfig { domain: DESTINATION, gas: GAS_LIMIT }];
    (*setup).local_token.set_destination_gas(Option::Some(config), Option::None, Option::None);
}

pub fn perform_remote_transfer(setup: @Setup, msg_value: u256, amount: u256) {
    start_prank(CheatTarget::One((*setup).local_token.contract_address), ALICE());

    let bob_felt: felt252 = BOB().into();
    let bob_address: u256 = bob_felt.into();
    (*setup)
        .local_token
        .transfer_remote(DESTINATION, bob_address, amount, msg_value, Option::None, Option::None);

    process_transfers(setup, BOB(), amount);

    let remote_token = IERC20Dispatcher {
        contract_address: (*setup).remote_token.contract_address
    };
    assert_eq!(remote_token.balance_of(BOB()), amount);

    stop_prank(CheatTarget::One((*setup).local_token.contract_address));
}

pub fn perform_remote_transfer_and_gas(
    setup: @Setup, msg_value: u256, amount: u256, gas_overhead: u256
) {
    perform_remote_transfer(setup, msg_value + gas_overhead, amount);
}

// NOTE: not implemented because it calls the above fn internally
pub fn perform_remote_transfer_with_emit() {}

pub fn perform_remote_transfer_and_gas_with_hook(
    setup: @Setup, msg_value: u256, amount: u256, hook: ContractAddress, hook_metadata: Bytes
) -> u256 {
    start_prank(CheatTarget::One((*setup).local_token.contract_address), ALICE());
    let token_router = ITokenRouterDispatcher {
        contract_address: (*setup).local_token.contract_address
    };
    let bob_felt: felt252 = BOB().into();
    let bob_address: u256 = bob_felt.into();
    let message_id = token_router
        .transfer_remote(
            DESTINATION,
            bob_address,
            amount,
            msg_value,
            Option::Some(hook_metadata),
            Option::Some(hook)
        );
    process_transfers(setup, BOB(), amount);

    let remote_token = IERC20Dispatcher {
        contract_address: (*setup).remote_token.contract_address
    };
    assert_eq!(remote_token.balance_of(BOB()), amount);
    stop_prank(CheatTarget::One((*setup).local_token.contract_address));
    message_id
}

pub fn test_transfer_with_hook_specified(setup: @Setup, fee: u256, metadata: Bytes) {
    let contract = declare("TestPostDispatchHook").unwrap();
    let (hook, _) = contract.deploy(@array![]).unwrap();
    let hook = ITestPostDispatchHookDispatcher { contract_address: hook };

    hook.set_fee(fee);

    start_prank(CheatTarget::One((*setup).primary_token.contract_address), ALICE());
    let primary_token = IERC20Dispatcher {
        contract_address: (*setup).primary_token.contract_address
    };
    primary_token.approve((*setup).local_token.contract_address, TRANSFER_AMT);

    let message_id = perform_remote_transfer_and_gas_with_hook(
        setup, 0, TRANSFER_AMT, hook.contract_address, metadata
    );

    assert!(hook.message_dispatched(message_id) == true, "Hook did not dispatch");
}

// NOTE: Not applicable on Starknet
fn test_benchmark_overhead_gas_usage() {}

#[test]
fn test_hyp_erc20_setup() {
    //let _ = setup();
    assert!(true, "");
}
