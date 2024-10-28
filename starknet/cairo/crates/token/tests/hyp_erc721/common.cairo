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
    // test_erc721::{ITestERC721Dispatcher, ITestERC721DispatcherTrait},
    test_interchain_gas_payment::{
        ITestInterchainGasPaymentDispatcher, ITestInterchainGasPaymentDispatcherTrait
    },
    test_erc721::{ITestERC721Dispatcher, ITestERC721DispatcherTrait}
};
use openzeppelin::token::erc721::interface::{IERC721Dispatcher, IERC721DispatcherTrait};
use snforge_std::cheatcodes::contract_class::ContractClass;
use snforge_std::{
    declare, ContractClassTrait, CheatTarget, EventSpy, EventAssertions, spy_events, SpyOn,
    start_prank, stop_prank, EventFetcher, event_name_hash
};
use starknet::ContractAddress;
use token::components::hyp_erc721_collateral_component::{
    IHypErc721CollateralDispatcher, IHypErc721CollateralDispatcherTrait
};
use token::components::hyp_erc721_component::{IHypErc721Dispatcher, IHypErc721DispatcherTrait};
use token::components::token_router::{ITokenRouterDispatcher, ITokenRouterDispatcherTrait};

const PUB_KEY: felt252 = 0x1;
const ZERO_SUPPLY: u256 = 0;
pub fn ZERO_ADDRESS() -> ContractAddress {
    starknet::contract_address_const::<'0x0'>()
}
fn EMPTY_STRING() -> ByteArray {
    ""
}
pub fn NAME() -> ByteArray {
    "Hyperlane Hedgehogs"
}
pub fn SYMBOL() -> ByteArray {
    "HHH"
}
pub fn ALICE() -> ContractAddress {
    starknet::contract_address_const::<'0x1'>()
}
pub fn BOB() -> ContractAddress {
    starknet::contract_address_const::<'0x2'>()
}
fn PROXY_ADMIN() -> ContractAddress {
    starknet::contract_address_const::<'0x37'>()
}
pub const INITIAL_SUPPLY: u256 = 10;
pub const ORIGIN: u32 = 11;
pub const DESTINATION: u32 = 22;
pub const TRANSFER_ID: u256 = 0;
pub fn URI() -> ByteArray {
    "http://bit.ly/3reJLpx"
}

#[starknet::interface]
pub trait IHypErc721Test<TContractState> {
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
    // ERC721
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn owner_of(self: @TContractState, token_id: u256) -> ContractAddress;
    fn safe_transfer_from(
        ref self: TContractState,
        from: ContractAddress,
        to: ContractAddress,
        token_id: u256,
        data: Span<felt252>
    );
    fn transfer_from(
        ref self: TContractState, from: ContractAddress, to: ContractAddress, token_id: u256
    );
    fn approve(ref self: TContractState, to: ContractAddress, token_id: u256);
    fn set_approval_for_all(ref self: TContractState, operator: ContractAddress, approved: bool);
    fn get_approved(self: @TContractState, token_id: u256) -> ContractAddress;
    fn is_approved_for_all(
        self: @TContractState, owner: ContractAddress, operator: ContractAddress
    ) -> bool;
    // HypERC721Collateral
    fn get_wrapped_token(self: @TContractState) -> ContractAddress;
    // HypERC721
    fn initialize(ref self: TContractState, mint_amount: u256, name: ByteArray, symbol: ByteArray);
    // HypERC721URIStorage
    fn name(self: @TContractState) -> ByteArray;
    fn symbol(self: @TContractState) -> ByteArray;
    fn token_uri(self: @TContractState, token_id: u256) -> ByteArray;
    fn set_token_uri(ref self: TContractState, token_id: u256, uri: ByteArray);
}

#[derive(Copy, Drop)]
pub struct Setup {
    pub local_primary_token: ITestERC721Dispatcher,
    pub remote_primary_token: ITestERC721Dispatcher,
    pub noop_hook: ITestPostDispatchHookDispatcher,
    pub default_ism: ContractAddress,
    pub local_mailbox: IMockMailboxDispatcher,
    pub remote_mailbox: IMockMailboxDispatcher,
    pub remote_token: IHypErc721TestDispatcher,
    pub local_token: IHypErc721TestDispatcher,
    pub hyp_erc721_contract: ContractClass,
    pub hyp_erc721_collateral_contract: ContractClass,
    pub alice: ContractAddress,
    pub bob: ContractAddress,
}

pub fn setup() -> Setup {
    let contract = declare("TestERC721").unwrap();
    let mut calldata: Array<felt252> = array![];
    (INITIAL_SUPPLY * 2).serialize(ref calldata);
    let (primary_token, _) = contract.deploy(@calldata).unwrap();
    let local_primary_token = ITestERC721Dispatcher { contract_address: primary_token };

    let (remote_primary_token, _) = contract.deploy(@calldata).unwrap();
    let remote_primary_token = ITestERC721Dispatcher { contract_address: remote_primary_token };

    let contract = declare("TestPostDispatchHook").unwrap();
    let (noop_hook, _) = contract.deploy(@array![]).unwrap();
    let noop_hook = ITestPostDispatchHookDispatcher { contract_address: noop_hook };

    let contract = declare("TestISM").unwrap();
    let (default_ism, _) = contract.deploy(@array![]).unwrap();

    let contract = declare("Ether").unwrap();
    let mut calldata: Array<felt252> = array![];
    starknet::get_contract_address().serialize(ref calldata);
    let (eth_address, _) = contract.deploy(@calldata).unwrap();
    //let eth = MockEthDispatcher { contract_address: eth_address };

    let contract = declare("MockMailbox").unwrap();
    let (local_mailbox, _) = contract
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

    let (remote_mailbox, _) = contract
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

    local_mailbox.set_default_hook(noop_hook.contract_address);
    local_mailbox.set_required_hook(noop_hook.contract_address);

    let hyp_erc721_collateral_contract = declare("HypErc721Collateral").unwrap();
    let (remote_token, _) = hyp_erc721_collateral_contract
        .deploy(
            @array![
                remote_primary_token.contract_address.into(),
                remote_mailbox.contract_address.into(),
                noop_hook.contract_address.into(),
                default_ism.into(),
                starknet::get_contract_address().into()
            ]
        )
        .unwrap();
    let remote_token = IHypErc721TestDispatcher { contract_address: remote_token };

    let hyp_erc721_contract = declare("HypErc721").unwrap();
    let mut calldata: Array<felt252> = array![];
    local_mailbox.contract_address.serialize(ref calldata);
    EMPTY_STRING().serialize(ref calldata);
    EMPTY_STRING().serialize(ref calldata);
    INITIAL_SUPPLY.serialize(ref calldata);
    calldata.append(noop_hook.contract_address.into());
    calldata.append(default_ism.into());
    calldata.append(starknet::get_contract_address().into());
    let (local_token, _) = hyp_erc721_contract.deploy(@calldata).unwrap();
    let local_token = IHypErc721TestDispatcher { contract_address: local_token };

    let contract = declare("MockAccount").unwrap();
    let (alice, _) = contract.deploy(@array![PUB_KEY]).unwrap();
    let (bob, _) = contract.deploy(@array![PUB_KEY]).unwrap();

    local_mailbox.add_remote_mail_box(DESTINATION, remote_mailbox.contract_address);
    remote_mailbox.add_remote_mail_box(ORIGIN, local_mailbox.contract_address);

    Setup {
        local_primary_token,
        remote_primary_token,
        noop_hook,
        default_ism,
        local_mailbox,
        remote_mailbox,
        remote_token,
        local_token,
        hyp_erc721_contract,
        hyp_erc721_collateral_contract,
        alice,
        bob,
    }
}

pub fn deploy_remote_token(mut setup: Setup, is_collateral: bool) -> Setup {
    if is_collateral {
        let mut calldata: Array<felt252> = array![];
        setup.remote_primary_token.contract_address.serialize(ref calldata);
        setup.remote_mailbox.contract_address.serialize(ref calldata);
        ZERO_ADDRESS().serialize(ref calldata);
        ZERO_ADDRESS().serialize(ref calldata);
        starknet::get_contract_address().serialize(ref calldata);
        let (remote_token, _) = setup.hyp_erc721_collateral_contract.deploy(@calldata).unwrap();
        setup.remote_token = IHypErc721TestDispatcher { contract_address: remote_token };
        setup
            .remote_primary_token
            .transfer_from(
                starknet::get_contract_address(), setup.remote_token.contract_address, 0
            );
    } else {
        let mut calldata: Array<felt252> = array![];
        setup.remote_mailbox.contract_address.serialize(ref calldata);
        NAME().serialize(ref calldata);
        SYMBOL().serialize(ref calldata);
        ZERO_SUPPLY.serialize(ref calldata);
        ZERO_ADDRESS().serialize(ref calldata);
        ZERO_ADDRESS().serialize(ref calldata);
        starknet::get_contract_address().serialize(ref calldata);
        let (remote_token, _) = setup.hyp_erc721_contract.deploy(@calldata).unwrap();
        setup.remote_token = IHypErc721TestDispatcher { contract_address: remote_token };
    }
    let local_token_address: felt252 = setup.local_token.contract_address.into();
    setup.remote_token.enroll_remote_router(ORIGIN, local_token_address.into());
    setup
}

pub fn process_transfer(setup: @Setup, recipient: ContractAddress, token_id: u256) {
    start_prank(
        CheatTarget::One((*setup).remote_token.contract_address),
        (*setup).remote_mailbox.contract_address
    );
    let mut message = BytesTrait::new_empty();
    message.append_address(recipient);
    message.append_u256(token_id);
    let local_token_address: felt252 = (*setup).local_token.contract_address.into();
    (*setup).remote_token.handle(ORIGIN, local_token_address.into(), message);
}

pub fn perform_remote_transfer(setup: @Setup, msg_value: u256, token_id: u256) {
    let alice_address: felt252 = (*setup).alice.into();
    (*setup)
        .local_token
        .transfer_remote(
            DESTINATION, alice_address.into(), token_id, msg_value, Option::None, Option::None
        );
    process_transfer(setup, (*setup).bob, token_id);
    assert_eq!((*setup).remote_token.balance_of((*setup).bob), 1);
}

#[test]
fn test_erc721_setup() {
    let _ = setup();
}
