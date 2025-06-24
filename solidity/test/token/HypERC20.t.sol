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
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {XERC20LockboxTest, XERC20Test, FiatTokenTest, ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";
import {FungibleTokenRouter} from "../../contracts/token/libs/FungibleTokenRouter.sol";

import {Router} from "../../contracts/client/Router.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {HypXERC20Lockbox} from "../../contracts/token/extensions/HypXERC20Lockbox.sol";
import {IXERC20} from "../../contracts/token/interfaces/IXERC20.sol";
import {IFiatToken} from "../../contracts/token/interfaces/IFiatToken.sol";
import {HypXERC20} from "../../contracts/token/extensions/HypXERC20.sol";
import {HypFiatToken} from "../../contracts/token/extensions/HypFiatToken.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";

abstract contract HypTokenTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;
    using Message for bytes;

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal REQUIRED_VALUE; // initialized in setUp
    uint256 internal constant GAS_LIMIT = 10_000;
    uint256 internal TRANSFER_AMT = 100e18;
    string internal constant NAME = "HyperlaneInu";
    string internal constant SYMBOL = "HYP";
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant CAROL = address(0x3);
    address internal constant DANIEL = address(0x4);
    address internal constant PROXY_ADMIN = address(0x37);

    ERC20Test internal primaryToken;
    FungibleTokenRouter internal localToken;
    HypERC20 internal remoteToken;
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;
    TestInterchainGasPaymaster internal igp;

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    event Transfer(address indexed from, address indexed to, uint256 value);

    event ReceivedTransferRemote(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amount
    );

    LinearFee internal feeContract;

    function setUp() public virtual {
        localMailbox = new MockMailbox(ORIGIN);
        remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        remoteMailbox.addRemoteMailbox(ORIGIN, localMailbox);

        primaryToken = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);

        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        REQUIRED_VALUE = noopHook.quoteDispatch("", "");

        HypERC20 implementation = new HypERC20(
            DECIMALS,
            SCALE,
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

    function _enrollLocalTokenRouter() internal {
        localToken.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
    }

    function _enrollRemoteTokenRouter() internal {
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );
    }

    function _connectRouters(
        uint32[] memory _domains,
        bytes32[] memory _addresses
    ) internal {
        uint256 n = _domains.length;
        for (uint256 i = 0; i < n; i++) {
            uint32[] memory complementDomains = new uint32[](n - 1);
            bytes32[] memory complementAddresses = new bytes32[](n - 1);

            uint256 j = 0;
            for (uint256 k = 0; k < n; k++) {
                if (k != i) {
                    complementDomains[j] = _domains[k];
                    complementAddresses[j] = _addresses[k];
                    j++;
                }
            }

            // Enroll complement routers into the current router, Routers - router_i
            Router(TypeCasts.bytes32ToAddress(_addresses[i]))
                .enrollRemoteRouters(complementDomains, complementAddresses);
        }
    }

    function _expectRemoteBalance(
        address _user,
        uint256 _balance
    ) internal view {
        assertEq(remoteToken.balanceOf(_user), _balance);
    }

    function _processTransfers() internal {
        remoteMailbox.processNextInboundMessage();
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
        _processTransfers();

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
        uint256 _amount,
        address _hook,
        bytes memory _hookMetadata
    ) internal returns (bytes32 messageId) {
        vm.prank(ALICE);
        messageId = localToken.transferRemote{value: _msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount,
            _hookMetadata,
            address(_hook)
        );
        _processTransfers();
        assertEq(remoteToken.balanceOf(BOB), _amount);
    }

    function testTransfer_withHookSpecified(
        uint256 fee,
        bytes calldata metadata
    ) public virtual {
        TestPostDispatchHook hook = new TestPostDispatchHook();
        hook.setFee(fee);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        bytes32 messageId = _performRemoteTransferWithHook(
            REQUIRED_VALUE,
            TRANSFER_AMT,
            address(hook),
            metadata
        );
        assertTrue(hook.messageDispatched(messageId));
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

    function testRemoteTransfer_withFee() public virtual {
        feeContract = new LinearFee(
            address(primaryToken),
            1e18,
            100e18,
            address(this)
        );
        localToken.setFeeRecipient(address(feeContract));
        uint256 fee = feeContract
        .quoteTransferRemote(DESTINATION, BOB.addressToBytes32(), TRANSFER_AMT)[
            0
        ].amount;
        uint256 total = TRANSFER_AMT + fee;

        uint256 nativeValue = REQUIRED_VALUE;
        if (address(primaryToken) != address(0)) {
            deal(address(primaryToken), ALICE, total);
            vm.prank(ALICE);
            primaryToken.approve(address(localToken), total);
        } else {
            vm.deal(ALICE, total);
            nativeValue += total;
        }

        (
            uint256 senderBefore,
            uint256 beneficiaryBefore,
            uint256 recipientBefore
        ) = _getBalances(ALICE, BOB);

        vm.prank(ALICE);
        localToken.transferRemote{value: nativeValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        _processTransfers();
        (
            uint256 senderAfter,
            uint256 beneficiaryAfter,
            uint256 recipientAfter
        ) = _getBalances(ALICE, BOB);

        assertEq(senderAfter, senderBefore - (TRANSFER_AMT + fee));
        assertEq(beneficiaryAfter, beneficiaryBefore + fee);
        assertEq(recipientAfter, recipientBefore + TRANSFER_AMT);
    }

    function _getBalances(
        address sender,
        address recipient
    )
        internal
        virtual
        returns (
            uint256 senderBalance,
            uint256 beneficiaryBalance,
            uint256 recipientBalance
        )
    {
        senderBalance = localToken.balanceOf(sender);
        beneficiaryBalance = localToken.balanceOf(address(feeContract));
        recipientBalance = remoteToken.balanceOf(recipient);
    }
}

contract HypERC20Test is HypTokenTest {
    using TypeCasts for address;

    HypERC20 internal erc20Token;

    function setUp() public override {
        super.setUp();

        HypERC20 implementation = new HypERC20(
            DECIMALS,
            SCALE,
            address(localMailbox)
        );
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
        primaryToken = ERC20Test(address(erc20Token));

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

    function testTotalSupply() public view {
        assertEq(erc20Token.totalSupply(), TOTAL_SUPPLY);
    }

    function testDecimals() public view {
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
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT * 11
        );
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
            SCALE,
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

    function test_constructor_revert_ifInvalidToken() public {
        vm.expectRevert("HypERC20Collateral: invalid token");
        new HypERC20Collateral(address(0), SCALE, address(localMailbox));
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
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
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

contract HypXERC20Test is HypTokenTest {
    using TypeCasts for address;

    HypXERC20 internal xerc20Collateral;

    function setUp() public override {
        super.setUp();

        primaryToken = new XERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);

        localToken = new HypXERC20(
            address(primaryToken),
            SCALE,
            address(localMailbox)
        );
        xerc20Collateral = HypXERC20(address(localToken));

        xerc20Collateral.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        primaryToken.transfer(address(localToken), 1000e18);
        primaryToken.transfer(ALICE, 1000e18);

        _enrollRemoteTokenRouter();
    }

    function testRemoteTransfer() public {
        uint256 balanceBefore = localToken.balanceOf(ALICE);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        vm.expectCall(
            address(primaryToken),
            abi.encodeCall(IXERC20.burn, (ALICE, TRANSFER_AMT))
        );
        _performRemoteTransferWithEmit(REQUIRED_VALUE, TRANSFER_AMT, 0);
        assertEq(localToken.balanceOf(ALICE), balanceBefore - TRANSFER_AMT);
    }

    function testHandle() public {
        vm.expectCall(
            address(primaryToken),
            abi.encodeCall(IXERC20.mint, (ALICE, TRANSFER_AMT))
        );
        _handleLocalTransfer(TRANSFER_AMT);
    }
}

contract HypXERC20LockboxTest is HypTokenTest {
    using TypeCasts for address;

    HypXERC20Lockbox internal xerc20Lockbox;

    function setUp() public override {
        super.setUp();

        XERC20LockboxTest lockbox = new XERC20LockboxTest(
            NAME,
            SYMBOL,
            TOTAL_SUPPLY,
            DECIMALS
        );
        primaryToken = ERC20Test(address(lockbox.ERC20()));

        localToken = new HypXERC20Lockbox(
            address(lockbox),
            SCALE,
            address(localMailbox)
        );
        xerc20Lockbox = HypXERC20Lockbox(address(localToken));

        xerc20Lockbox.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        primaryToken.transfer(ALICE, 1000e18);

        _enrollRemoteTokenRouter();
    }

    uint256 constant MAX_INT = 2 ** 256 - 1;

    function testApproval() public {
        assertEq(
            xerc20Lockbox.xERC20().allowance(
                address(localToken),
                address(xerc20Lockbox.lockbox())
            ),
            MAX_INT
        );
        assertEq(
            xerc20Lockbox.wrappedToken().allowance(
                address(localToken),
                address(xerc20Lockbox.lockbox())
            ),
            MAX_INT
        );
    }

    function testRemoteTransfer() public {
        uint256 balanceBefore = localToken.balanceOf(ALICE);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        vm.expectCall(
            address(xerc20Lockbox.xERC20()),
            abi.encodeCall(IXERC20.burn, (address(localToken), TRANSFER_AMT))
        );
        _performRemoteTransferWithEmit(REQUIRED_VALUE, TRANSFER_AMT, 0);
        assertEq(localToken.balanceOf(ALICE), balanceBefore - TRANSFER_AMT);
    }

    function testHandle() public {
        uint256 balanceBefore = localToken.balanceOf(ALICE);
        vm.expectCall(
            address(xerc20Lockbox.xERC20()),
            abi.encodeCall(IXERC20.mint, (address(localToken), TRANSFER_AMT))
        );
        _handleLocalTransfer(TRANSFER_AMT);
        assertEq(localToken.balanceOf(ALICE), balanceBefore + TRANSFER_AMT);
    }
}

contract HypFiatTokenTest is HypTokenTest {
    using TypeCasts for address;

    HypFiatToken internal fiatToken;

    function setUp() public override {
        super.setUp();

        primaryToken = new FiatTokenTest(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);

        localToken = new HypFiatToken(
            address(primaryToken),
            SCALE,
            address(localMailbox)
        );
        fiatToken = HypFiatToken(address(localToken));

        fiatToken.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        primaryToken.transfer(address(localToken), 1000e18);
        primaryToken.transfer(ALICE, 1000e18);

        _enrollRemoteTokenRouter();
    }

    function testRemoteTransfer() public {
        uint256 balanceBefore = localToken.balanceOf(ALICE);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        vm.expectCall(
            address(primaryToken),
            abi.encodeCall(IFiatToken.burn, (TRANSFER_AMT))
        );
        _performRemoteTransferWithEmit(REQUIRED_VALUE, TRANSFER_AMT, 0);
        assertEq(localToken.balanceOf(ALICE), balanceBefore - TRANSFER_AMT);
    }

    function testHandle() public {
        bytes memory data = abi.encodeCall(
            IFiatToken.mint,
            (ALICE, TRANSFER_AMT)
        );
        vm.mockCall(address(primaryToken), 0, data, abi.encode(false));
        vm.expectRevert("FiatToken mint failed");
        _handleLocalTransfer(TRANSFER_AMT);
        vm.clearMockedCalls();

        vm.expectCall(address(primaryToken), data);
        _handleLocalTransfer(TRANSFER_AMT);
    }
}

contract HypNativeTest is HypTokenTest {
    using TypeCasts for address;

    HypNative internal nativeToken;

    function setUp() public override {
        super.setUp();

        localToken = new HypNative(SCALE, address(localMailbox));
        nativeToken = HypNative(payable(address(localToken)));
        primaryToken = ERC20Test(address(0));

        nativeToken.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        vm.deal(address(localToken), 1000e18);
        vm.deal(ALICE, 1000e18);

        _enrollRemoteTokenRouter();
    }

    function testTransfer_withHookSpecified(
        uint256 fee,
        bytes calldata metadata
    ) public override {
        TestPostDispatchHook hook = new TestPostDispatchHook();
        hook.setFee(fee);

        uint256 value = REQUIRED_VALUE + TRANSFER_AMT;

        bytes32 messageId = _performRemoteTransferWithHook(
            value,
            TRANSFER_AMT,
            address(hook),
            metadata
        );
        assertTrue(hook.messageDispatched(messageId));
    }

    function testRemoteTransfer() public {
        _performRemoteTransferWithEmit(
            REQUIRED_VALUE,
            TRANSFER_AMT,
            TRANSFER_AMT
        );
    }

    function testRemoteTransfer_invalidAmount() public {
        vm.expectRevert("Native: amount exceeds msg.value");
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE + TRANSFER_AMT}(
            DESTINATION,
            BOB.addressToBytes32(),
            REQUIRED_VALUE + TRANSFER_AMT + 1
        );
        assertEq(localToken.balanceOf(ALICE), 1000e18);
    }

    function testRemoteTransfer_withCustomGasConfig() public {
        _setCustomGasConfig();

        uint256 balanceBefore = ALICE.balance;
        uint256 gasOverhead = GAS_LIMIT * igp.gasPrice();
        _performRemoteTransfer(TRANSFER_AMT + gasOverhead, TRANSFER_AMT);
        assertEq(
            ALICE.balance,
            balanceBefore - TRANSFER_AMT - REQUIRED_VALUE - gasOverhead
        );
    }

    function test_transferRemote_reverts_whenAmountExceedsValue(
        uint256 nativeValue
    ) public {
        vm.assume(nativeValue < address(this).balance);

        address recipient = address(0xdeadbeef);
        bytes32 bRecipient = TypeCasts.addressToBytes32(recipient);
        vm.expectRevert("Native: amount exceeds msg.value");
        nativeToken.transferRemote{value: nativeValue}(
            DESTINATION,
            bRecipient,
            nativeValue + 1
        );

        vm.expectRevert("Native: amount exceeds msg.value");
        nativeToken.transferRemote{value: nativeValue}(
            DESTINATION,
            bRecipient,
            nativeValue + 1,
            bytes(""),
            address(0)
        );
    }
}

contract HypERC20ScaledTest is HypTokenTest {
    using TypeCasts for address;

    HypERC20 internal erc20Token;

    uint256 constant EFFECTIVE_SCALE = 1e2;

    function setUp() public override {
        super.setUp();

        HypERC20 implementation = new HypERC20(
            DECIMALS,
            EFFECTIVE_SCALE,
            address(localMailbox)
        );

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
        erc20Token.transfer(ALICE, TRANSFER_AMT);
        primaryToken = ERC20Test(address(erc20Token));

        _enrollLocalTokenRouter();
        _enrollRemoteTokenRouter();
    }

    function testRemoteTransfer() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(ALICE, address(0x0), TRANSFER_AMT);

        vm.expectEmit(true, true, false, true);
        emit SentTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT * EFFECTIVE_SCALE
        );

        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function testHandle() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0x0), ALICE, TRANSFER_AMT / EFFECTIVE_SCALE);

        vm.expectEmit(true, true, false, true);
        emit ReceivedTransferRemote(
            DESTINATION,
            ALICE.addressToBytes32(),
            TRANSFER_AMT
        );

        _handleLocalTransfer(TRANSFER_AMT);
    }

    function testTransfer_withHookSpecified(
        uint256 fee,
        bytes calldata metadata
    ) public override {
        TestPostDispatchHook hook = new TestPostDispatchHook();
        hook.setFee(fee);

        vm.prank(ALICE);
        bytes32 messageId = localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            metadata,
            address(hook)
        );
        assertTrue(hook.messageDispatched(messageId));
    }

    function _getBalances(
        address sender,
        address recipient
    )
        internal
        override
        returns (
            uint256 senderBalance,
            uint256 beneficiaryBalance,
            uint256 recipientBalance
        )
    {
        (senderBalance, beneficiaryBalance, recipientBalance) = super
            ._getBalances(sender, recipient);
        recipientBalance = recipientBalance / EFFECTIVE_SCALE;
    }
}
