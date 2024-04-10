// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {Mailbox} from "../../contracts/Mailbox.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";

import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";

abstract contract HypTokenTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;
    using Message for bytes;

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal REQUIRED_VALUE; // initialized in setUp
    uint256 internal constant GAS_LIMIT = 10_000;
    uint256 internal constant TRANSFER_AMT = 100e18;
    string internal constant NAME = "HyperlaneInu";
    string internal constant SYMBOL = "HYP";
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant PROXY_ADMIN = address(0x37);

    ERC20Test internal primaryToken;
    TokenRouter internal localToken;
    HypERC20 internal remoteToken;
    TestMailbox internal localMailbox;
    TestMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;
    TestInterchainGasPaymaster internal igp;

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    event ReceivedTransferRemote(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amount
    );

    function setUp() public virtual {
        localMailbox = new TestMailbox(ORIGIN);
        remoteMailbox = new TestMailbox(DESTINATION);

        primaryToken = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);

        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));

        REQUIRED_VALUE = noopHook.quoteDispatch("", "");

        HypERC20 implementation = new HypERC20(
            DECIMALS,
            address(remoteMailbox)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                TOTAL_SUPPLY,
                NAME,
                SYMBOL,
                address(noopHook),
                address(igp),
                address(this)
            )
        );
        remoteToken = HypERC20(address(proxy));
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );
        igp = new TestInterchainGasPaymaster();
        vm.deal(ALICE, 125000);
    }

    function _enrollRemoteTokenRouter() internal {
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );
    }

    function _expectRemoteBalance(address _user, uint256 _balance) internal {
        assertEq(remoteToken.balanceOf(_user), _balance);
    }

    function _processTransfers(address _recipient, uint256 _amount) internal {
        vm.prank(address(remoteMailbox));
        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            abi.encodePacked(_recipient.addressToBytes32(), _amount)
        );
    }

    function _handleLocalTransfer(uint256 _transferAmount) internal {
        vm.prank(address(localMailbox));
        localToken.handle(
            DESTINATION,
            address(remoteToken).addressToBytes32(),
            abi.encodePacked(ALICE.addressToBytes32(), _transferAmount)
        );
    }

    function _mintAndApprove(uint256 _amount, address _account) internal {
        primaryToken.mint(_amount);
        primaryToken.approve(_account, _amount);
    }

    function _setCustomGasConfig() internal {
        localToken.setHook(address(igp));

        TokenRouter.GasRouterConfig[]
            memory config = new TokenRouter.GasRouterConfig[](1);
        config[0] = GasRouter.GasRouterConfig({
            domain: DESTINATION,
            gas: GAS_LIMIT
        });
        localToken.setDestinationGas(config);
    }

    function _performRemoteTransfer(
        uint256 _msgValue,
        uint256 _amount
    ) internal {
        vm.prank(ALICE);
        localToken.transferRemote{value: _msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );

        vm.expectEmit(true, true, false, true);
        emit ReceivedTransferRemote(ORIGIN, BOB.addressToBytes32(), _amount);
        _processTransfers(BOB, _amount);

        assertEq(remoteToken.balanceOf(BOB), _amount);
    }

    function _performRemoteTransferAndGas(
        uint256 _msgValue,
        uint256 _amount,
        uint256 _gasOverhead
    ) internal {
        uint256 ethBalance = ALICE.balance;
        _performRemoteTransfer(_msgValue + _gasOverhead, _amount);
        assertEq(ALICE.balance, ethBalance - REQUIRED_VALUE - _gasOverhead);
    }

    function _performRemoteTransferWithEmit(
        uint256 _msgValue,
        uint256 _amount,
        uint256 _gasOverhead
    ) internal {
        vm.expectEmit(true, true, false, true);
        emit SentTransferRemote(DESTINATION, BOB.addressToBytes32(), _amount);
        _performRemoteTransferAndGas(_msgValue, _amount, _gasOverhead);
    }

    function _performRemoteTransferWithHook(
        uint256 _msgValue,
        uint256 _amount
    ) internal returns (bytes32 messageId) {
        vm.prank(ALICE);
        messageId = localToken.transferRemote{value: _msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount,
            bytes(""),
            address(noopHook)
        );
        _processTransfers(BOB, _amount);
        assertEq(remoteToken.balanceOf(BOB), _amount);
    }

    function testTransfer_withHookSpecified() public {
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        bytes32 messageId = _performRemoteTransferWithHook(
            REQUIRED_VALUE,
            TRANSFER_AMT
        );
        assertTrue(noopHook.messageDispatched(messageId));
        /// @dev Using this test would be ideal, but vm.expectCall with nested functions more than 1 level deep is broken
        /// In other words, the call graph of Route.transferRemote() -> Mailbox.dispatch() -> Hook.postDispatch() does not work with expectCall
        // vm.expectCall(
        //     address(noopHook),
        //     abi.encodeCall(
        //         IPostDispatchHook.postDispatch,
        //         (bytes(""), outboundMessage)
        //     )
        // );
        /// @dev Also, using expectedCall with Mailbox.dispatch() won't work either because overloaded function selection is broken, see https://github.com/ethereum/solidity/issues/13815
    }

    function testBenchmark_overheadGasUsage() public virtual {
        vm.prank(address(localMailbox));

        uint256 gasBefore = gasleft();
        localToken.handle(
            DESTINATION,
            address(remoteToken).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), TRANSFER_AMT)
        );
        uint256 gasAfter = gasleft();
        console.log("Overhead gas usage: %d", gasBefore - gasAfter);
    }
}

contract HypERC20Test is HypTokenTest {
    using TypeCasts for address;
    HypERC20 internal erc20Token;

    function setUp() public override {
        super.setUp();

        HypERC20 implementation = new HypERC20(DECIMALS, address(localMailbox));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                TOTAL_SUPPLY,
                NAME,
                SYMBOL,
                address(address(noopHook)),
                address(igp),
                address(this)
            )
        );
        localToken = HypERC20(address(proxy));
        erc20Token = HypERC20(address(proxy));

        erc20Token.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        erc20Token.transfer(ALICE, 1000e18);

        _enrollRemoteTokenRouter();
    }

    function testInitialize_revert_ifAlreadyInitialized() public {
        vm.expectRevert("Initializable: contract is already initialized");
        erc20Token.initialize(
            TOTAL_SUPPLY,
            NAME,
            SYMBOL,
            address(address(noopHook)),
            address(igp),
            BOB
        );
    }

    function testTotalSupply() public {
        assertEq(erc20Token.totalSupply(), TOTAL_SUPPLY);
    }

    function testDecimals() public {
        assertEq(erc20Token.decimals(), DECIMALS);
    }

    function testLocalTransfers() public {
        assertEq(erc20Token.balanceOf(ALICE), 1000e18);
        assertEq(erc20Token.balanceOf(BOB), 0);

        vm.prank(ALICE);
        erc20Token.transfer(BOB, 100e18);
        assertEq(erc20Token.balanceOf(ALICE), 900e18);
        assertEq(erc20Token.balanceOf(BOB), 100e18);
    }

    function testRemoteTransfer() public {
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );
        uint256 balanceBefore = erc20Token.balanceOf(ALICE);
        _performRemoteTransferWithEmit(REQUIRED_VALUE, TRANSFER_AMT, 0);
        assertEq(erc20Token.balanceOf(ALICE), balanceBefore - TRANSFER_AMT);
    }

    function testRemoteTransfer_invalidAmount() public {
        vm.expectRevert("ERC20: burn amount exceeds balance");
        _performRemoteTransfer(REQUIRED_VALUE, TRANSFER_AMT * 11);
        assertEq(erc20Token.balanceOf(ALICE), 1000e18);
    }

    function testRemoteTransfer_withCustomGasConfig() public {
        _setCustomGasConfig();

        uint256 balanceBefore = erc20Token.balanceOf(ALICE);
        _performRemoteTransferAndGas(
            REQUIRED_VALUE,
            TRANSFER_AMT,
            GAS_LIMIT * igp.gasPrice()
        );
        assertEq(erc20Token.balanceOf(ALICE), balanceBefore - TRANSFER_AMT);
    }
}

contract HypERC20CollateralTest is HypTokenTest {
    using TypeCasts for address;
    HypERC20Collateral internal erc20Collateral;

    function setUp() public override {
        super.setUp();

        localToken = new HypERC20Collateral(
            address(primaryToken),
            address(localMailbox)
        );
        erc20Collateral = HypERC20Collateral(address(localToken));

        erc20Collateral.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        primaryToken.transfer(address(localToken), 1000e18);
        primaryToken.transfer(ALICE, 1000e18);

        _enrollRemoteTokenRouter();
    }

    function testInitialize_revert_ifAlreadyInitialized() public {}

    function testRemoteTransfer() public {
        uint256 balanceBefore = localToken.balanceOf(ALICE);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        _performRemoteTransferWithEmit(REQUIRED_VALUE, TRANSFER_AMT, 0);
        assertEq(localToken.balanceOf(ALICE), balanceBefore - TRANSFER_AMT);
    }

    function testRemoteTransfer_invalidAllowance() public {
        vm.expectRevert("ERC20: insufficient allowance");
        _performRemoteTransfer(REQUIRED_VALUE, TRANSFER_AMT);
        assertEq(localToken.balanceOf(ALICE), 1000e18);
    }

    function testRemoteTransfer_withCustomGasConfig() public {
        _setCustomGasConfig();

        uint256 balanceBefore = localToken.balanceOf(ALICE);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        _performRemoteTransferAndGas(
            REQUIRED_VALUE,
            TRANSFER_AMT,
            GAS_LIMIT * igp.gasPrice()
        );
        assertEq(localToken.balanceOf(ALICE), balanceBefore - TRANSFER_AMT);
    }
}

contract HypNativeTest is HypTokenTest {
    using TypeCasts for address;
    HypNative internal nativeToken;

    function setUp() public override {
        super.setUp();

        localToken = new HypNative(address(localMailbox));
        nativeToken = HypNative(payable(address(localToken)));

        nativeToken.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        vm.deal(address(localToken), 1000e18);
        vm.deal(ALICE, 1000e18);

        _enrollRemoteTokenRouter();
    }

    function testInitialize_revert_ifAlreadyInitialized() public {}

    function testRemoteTransfer() public {
        _performRemoteTransferWithEmit(
            REQUIRED_VALUE,
            TRANSFER_AMT,
            TRANSFER_AMT
        );
    }

    function testRemoteTransfer_invalidAmount() public {
        vm.expectRevert("Native: amount exceeds msg.value");
        _performRemoteTransfer(
            REQUIRED_VALUE + TRANSFER_AMT,
            TRANSFER_AMT * 10
        );
        assertEq(localToken.balanceOf(ALICE), 1000e18);
    }

    function testRemoteTransfer_withCustomGasConfig() public {
        _setCustomGasConfig();

        _performRemoteTransferAndGas(
            REQUIRED_VALUE,
            TRANSFER_AMT,
            TRANSFER_AMT + GAS_LIMIT * igp.gasPrice()
        );
    }
}
