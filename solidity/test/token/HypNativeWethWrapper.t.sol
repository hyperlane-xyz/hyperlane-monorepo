// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {IWETH} from "../../contracts/token/interfaces/IWETH.sol";
import {HypNativeWethWrapper} from "../../contracts/token/extensions/HypNativeWethWrapper.sol";
import {HypNativeWethWrapperFactory} from "../../contracts/token/extensions/HypNativeWethWrapperFactory.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {Quotes} from "../../contracts/token/libs/Quotes.sol";

/// @dev Minimal WETH9-compatible token for unit tests.
contract TestWETH is IWETH {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    function totalSupply() external view override returns (uint256) {
        return address(this).balance;
    }

    function deposit() public payable override {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external override {
        require(balanceOf[msg.sender] >= amount, "WETH: balance");
        balanceOf[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "WETH: send failed");
        emit Withdrawal(msg.sender, amount);
    }

    function approve(
        address spender,
        uint256 amount
    ) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(
        address to,
        uint256 amount
    ) external override returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "WETH: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal returns (bool) {
        require(balanceOf[from] >= amount, "WETH: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    receive() external payable {
        deposit();
    }
}

contract HypNativeWethWrapperTest is Test {
    using TypeCasts for address;
    using Quotes for Quote[];

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint256 internal constant TRANSFER_AMT = 1 ether;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;
    HypNative internal localRouter;
    HypNative internal remoteRouter;
    TestWETH internal weth;
    HypNativeWethWrapper internal wrapper;

    function setUp() public {
        localMailbox = new MockMailbox(ORIGIN);
        remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        remoteMailbox.addRemoteMailbox(ORIGIN, localMailbox);

        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        localRouter = new HypNative(1, 1, address(localMailbox));
        localRouter.initialize(address(0), address(0), address(this));
        remoteRouter = new HypNative(1, 1, address(remoteMailbox));
        remoteRouter.initialize(address(0), address(0), address(this));

        localRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteRouter).addressToBytes32()
        );
        remoteRouter.enrollRemoteRouter(
            ORIGIN,
            address(localRouter).addressToBytes32()
        );

        weth = new TestWETH();
        wrapper = new HypNativeWethWrapper(IWETH(address(weth)), localRouter);

        vm.label(ALICE, "ALICE");
        vm.label(BOB, "BOB");
        vm.label(address(wrapper), "wrapper");
        vm.label(address(localRouter), "localRouter");
        vm.label(address(remoteRouter), "remoteRouter");
    }

    // -------------------------------------------------------------------------
    // Wrapper: constructor guard
    // -------------------------------------------------------------------------

    function test_constructor_revertsOnNonNativeRouter() public {
        vm.expectRevert();
        new HypNativeWethWrapper(
            IWETH(address(weth)),
            HypNative(payable(address(weth)))
        );
    }

    function test_constructor_setsImmutables() public view {
        assertEq(wrapper.token(), address(weth));
    }

    // -------------------------------------------------------------------------
    // Wrapper: transferRemote
    // -------------------------------------------------------------------------

    function test_transferRemote_pullsWethAndDispatches() public {
        uint256 total = _totalWethRequired(TRANSFER_AMT);
        _fundAliceWeth(total);

        vm.prank(ALICE);
        wrapper.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // Full amount pulled as WETH and unwrapped; wrapper ends with nothing.
        assertEq(weth.balanceOf(ALICE), 0);
        assertEq(weth.balanceOf(address(wrapper)), 0);
        assertEq(address(wrapper).balance, 0);
        assertEq(address(localRouter).balance, TRANSFER_AMT);

        // Deliver message and confirm BOB gets native on destination.
        uint256 bobBefore = BOB.balance;
        vm.deal(address(remoteRouter), TRANSFER_AMT);
        remoteMailbox.processNextInboundMessage();
        assertEq(BOB.balance - bobBefore, TRANSFER_AMT);
    }

    function test_transferRemote_revertsWithNonZeroMsgValue() public {
        uint256 total = _totalWethRequired(TRANSFER_AMT);
        _fundAliceWeth(total);

        vm.deal(ALICE, 1 wei);
        vm.prank(ALICE);
        vm.expectRevert(bytes("Wrapper: msg.value must be 0"));
        wrapper.transferRemote{value: 1 wei}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemote_revertsWithoutApproval() public {
        uint256 total = _totalWethRequired(TRANSFER_AMT);
        vm.deal(ALICE, total);
        vm.prank(ALICE);
        weth.deposit{value: total}();
        // No approval.
        vm.prank(ALICE);
        vm.expectRevert();
        wrapper.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemote_revertsWithInsufficientWethBalance() public {
        uint256 total = _totalWethRequired(TRANSFER_AMT);
        vm.prank(ALICE);
        weth.approve(address(wrapper), total);
        vm.prank(ALICE);
        vm.expectRevert();
        wrapper.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    // -------------------------------------------------------------------------
    // Wrapper: quoteTransferRemote
    // -------------------------------------------------------------------------

    function test_quoteTransferRemote_mirrorsHypNativeShapeInWeth()
        public
        view
    {
        Quote[] memory nativeQuotes = localRouter.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        Quote[] memory wrapperQuotes = wrapper.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // 3-entry shape: [0] gas payment, [1] amount + internal fee, [2] external fee.
        assertEq(wrapperQuotes.length, nativeQuotes.length);
        for (uint256 i = 0; i < wrapperQuotes.length; i++) {
            assertEq(wrapperQuotes[i].token, address(weth));
            assertEq(wrapperQuotes[i].amount, nativeQuotes[i].amount);
        }
    }

    function test_token_returnsWeth() public view {
        assertEq(wrapper.token(), address(weth));
    }

    // -------------------------------------------------------------------------
    // Factory
    // -------------------------------------------------------------------------

    function test_factory_getAddressMatchesDeployedAddress() public {
        HypNativeWethWrapperFactory factory = new HypNativeWethWrapperFactory(
            IWETH(address(weth))
        );

        HypNativeWethWrapper predicted = factory.getAddress(localRouter);
        assertEq(address(predicted).code.length, 0);

        HypNativeWethWrapper deployed = factory.deploy(localRouter);
        assertEq(address(deployed), address(predicted));
        assertGt(address(deployed).code.length, 0);

        assertEq(deployed.token(), address(weth));
    }

    function test_factory_deployIsIdempotent() public {
        HypNativeWethWrapperFactory factory = new HypNativeWethWrapperFactory(
            IWETH(address(weth))
        );

        HypNativeWethWrapper first = factory.deploy(localRouter);
        HypNativeWethWrapper second = factory.deploy(localRouter);
        assertEq(address(first), address(second));
    }

    function test_factory_distinctRoutersYieldDistinctWrappers() public {
        HypNativeWethWrapperFactory factory = new HypNativeWethWrapperFactory(
            IWETH(address(weth))
        );

        HypNative secondRouter = new HypNative(1, 1, address(localMailbox));
        secondRouter.initialize(address(0), address(0), address(this));

        HypNativeWethWrapper a = factory.deploy(localRouter);
        HypNativeWethWrapper b = factory.deploy(secondRouter);
        assertTrue(address(a) != address(b));
    }

    function test_factory_deployedWrapperBridgesCorrectly() public {
        HypNativeWethWrapperFactory factory = new HypNativeWethWrapperFactory(
            IWETH(address(weth))
        );
        HypNativeWethWrapper deployed = factory.deploy(localRouter);

        uint256 total = _totalWethRequired(TRANSFER_AMT);
        vm.deal(ALICE, total);
        vm.prank(ALICE);
        weth.deposit{value: total}();
        vm.prank(ALICE);
        weth.approve(address(deployed), total);

        vm.prank(ALICE);
        deployed.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        assertEq(address(localRouter).balance, TRANSFER_AMT);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _totalWethRequired(
        uint256 _amount
    ) internal view returns (uint256 total) {
        Quote[] memory quotes = wrapper.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );
        for (uint256 i = 0; i < quotes.length; i++) {
            if (quotes[i].token == address(weth)) {
                total += quotes[i].amount;
            }
        }
    }

    function _fundAliceWeth(uint256 _amount) internal {
        vm.deal(ALICE, _amount);
        vm.prank(ALICE);
        weth.deposit{value: _amount}();
        vm.prank(ALICE);
        weth.approve(address(wrapper), _amount);
    }
}
