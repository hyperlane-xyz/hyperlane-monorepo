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

import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {Message} from "contracts/libs/Message.sol";
import {MockHyperlaneEnvironment} from "contracts/mock/MockHyperlaneEnvironment.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";
import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {ITokenFee, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CallLib} from "contracts/middleware/libs/Call.sol";
import {AbstractOffchainQuoter} from "contracts/libs/AbstractOffchainQuoter.sol";
import {SignedQuote} from "contracts/interfaces/IOffchainQuoter.sol";
import {OffchainQuotedLinearFee, FeeQuoteData, FeeQuoteContext} from "contracts/token/fees/OffchainQuotedLinearFee.sol";
import {QuotedCalls} from "contracts/token/QuotedCalls.sol";
import {IAllowanceTransfer} from "permit2/interfaces/IAllowanceTransfer.sol";

import {CrossCollateralRouter} from "contracts/token/CrossCollateralRouter.sol";
import {CrossCollateralRoutingFee} from "contracts/token/CrossCollateralRoutingFee.sol";
import {ICrossCollateralFee} from "contracts/token/interfaces/ICrossCollateralFee.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";
import {GasRouter} from "contracts/client/GasRouter.sol";
import {LinearFee} from "contracts/token/fees/LinearFee.sol";

/// @notice Mock fee contract: fixed percentage fee.
/// Implements both ITokenFee (for base transferRemote) and ICrossCollateralFee (for transferRemoteTo).
contract MockDepositFee is ITokenFee, ICrossCollateralFee {
    address public immutable token;
    uint256 public immutable feeBps;

    constructor(address _token, uint256 _feeBps) {
        token = _token;
        feeBps = _feeBps;
    }

    function quoteTransferRemote(
        uint32,
        bytes32,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(token, (_amount * feeBps) / 10000);
    }

    function quoteTransferRemoteTo(
        uint32,
        bytes32,
        uint256 _amount,
        bytes32 /*_targetRouter*/
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(token, (_amount * feeBps) / 10000);
    }
}

/// @notice Mock fee contract that implements only ICrossCollateralFee.
contract MockRouterOnlyFee is ICrossCollateralFee {
    address public immutable token;
    uint256 public immutable feeBps;

    constructor(address _token, uint256 _feeBps) {
        token = _token;
        feeBps = _feeBps;
    }

    function quoteTransferRemoteTo(
        uint32,
        bytes32,
        uint256 _amount,
        bytes32 /*_targetRouter*/
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(token, (_amount * feeBps) / 10000);
    }
}

contract FixedQuoteHook is IPostDispatchHook {
    uint256 public immutable quote;

    constructor(uint256 _quote) {
        quote = _quote;
    }

    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.UNUSED);
    }

    function supportsMetadata(bytes calldata) external pure returns (bool) {
        return true;
    }

    function postDispatch(bytes calldata, bytes calldata) external payable {}

    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external view returns (uint256) {
        return quote;
    }
}

contract MessageAmountQuoteHook is IPostDispatchHook {
    using Message for bytes;
    using TokenMessage for bytes;

    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.UNUSED);
    }

    function supportsMetadata(bytes calldata) external pure returns (bool) {
        return true;
    }

    function postDispatch(bytes calldata, bytes calldata) external payable {}

    function quoteDispatch(
        bytes calldata,
        bytes calldata message
    ) external pure returns (uint256) {
        return message.body().amount();
    }
}

contract CrossCollateralRouterTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    uint32 internal constant ORIGIN = 1;
    uint32 internal constant DESTINATION = 2;

    // Scale: numerator/denominator. USDC 6→18: multiply by 1e12/1. USDT 18→18: 1/1.
    uint256 internal constant USDC_SCALE_NUM = 1e12;
    uint256 internal constant USDC_SCALE_DEN = 1;
    uint256 internal constant USDT_SCALE_NUM = 1;
    uint256 internal constant USDT_SCALE_DEN = 1;
    uint256 internal constant DEFAULT_FEE_BPS = 5; // 0.05%

    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant PROXY_ADMIN = address(0x37);
    address internal constant UNAUTHORIZED = address(0x999);

    // Environment
    MockHyperlaneEnvironment internal env;
    MockMailbox internal originMailbox;
    MockMailbox internal destMailbox;

    // Tokens
    ERC20Test internal originUSDC; // 6 decimals
    ERC20Test internal originUSDT; // 18 decimals
    ERC20Test internal destUSDC; // 6 decimals
    ERC20Test internal destUSDT; // 18 decimals

    // Routers (behind proxies)
    CrossCollateralRouter internal usdcRouterA; // domain 1, USDC
    CrossCollateralRouter internal usdtRouterA; // domain 1, USDT
    CrossCollateralRouter internal usdcRouterB; // domain 2, USDC
    CrossCollateralRouter internal usdtRouterB; // domain 2, USDT

    // Fee contracts
    MockDepositFee internal originUsdcFee;
    MockDepositFee internal originUsdtFee;
    MockDepositFee internal destUsdcFee;
    MockDepositFee internal destUsdtFee;

    function setUp() public {
        // ---- Environment ----
        env = new MockHyperlaneEnvironment(ORIGIN, DESTINATION);
        originMailbox = env.mailboxes(ORIGIN);
        destMailbox = env.mailboxes(DESTINATION);

        // ---- Tokens ----
        originUSDC = new ERC20Test("USD Coin", "USDC", 0, 6);
        originUSDT = new ERC20Test("Tether USD", "USDT", 0, 18);
        destUSDC = new ERC20Test("USD Coin", "USDC", 0, 6);
        destUSDT = new ERC20Test("Tether USD", "USDT", 0, 18);

        // ---- Deploy routers behind proxies ----
        usdcRouterA = _deployRouter(
            address(originUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(originMailbox)
        );
        usdtRouterA = _deployRouter(
            address(originUSDT),
            USDT_SCALE_NUM,
            USDT_SCALE_DEN,
            address(originMailbox)
        );
        usdcRouterB = _deployRouter(
            address(destUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(destMailbox)
        );
        usdtRouterB = _deployRouter(
            address(destUSDT),
            USDT_SCALE_NUM,
            USDT_SCALE_DEN,
            address(destMailbox)
        );

        // ---- Fee contracts ----
        originUsdcFee = new MockDepositFee(
            address(originUSDC),
            DEFAULT_FEE_BPS
        );
        originUsdtFee = new MockDepositFee(
            address(originUSDT),
            DEFAULT_FEE_BPS
        );
        destUsdcFee = new MockDepositFee(address(destUSDC), DEFAULT_FEE_BPS);
        destUsdtFee = new MockDepositFee(address(destUSDT), DEFAULT_FEE_BPS);

        usdcRouterA.setFeeRecipient(address(originUsdcFee));
        usdtRouterA.setFeeRecipient(address(originUsdtFee));
        usdcRouterB.setFeeRecipient(address(destUsdcFee));
        usdtRouterB.setFeeRecipient(address(destUsdtFee));

        // ---- Same-stablecoin: enroll as remote routers ----
        usdcRouterA.enrollRemoteRouter(
            DESTINATION,
            address(usdcRouterB).addressToBytes32()
        );
        usdcRouterB.enrollRemoteRouter(
            ORIGIN,
            address(usdcRouterA).addressToBytes32()
        );
        usdtRouterA.enrollRemoteRouter(
            DESTINATION,
            address(usdtRouterB).addressToBytes32()
        );
        usdtRouterB.enrollRemoteRouter(
            ORIGIN,
            address(usdtRouterA).addressToBytes32()
        );

        // ---- Cross-stablecoin + same-chain: batch enroll routers ----
        _batchEnroll(
            usdcRouterA,
            _arr2(DESTINATION, ORIGIN),
            _arr2(
                address(usdtRouterB).addressToBytes32(),
                address(usdtRouterA).addressToBytes32()
            )
        );
        _batchEnroll(
            usdtRouterB,
            _arr2(ORIGIN, DESTINATION),
            _arr2(
                address(usdcRouterA).addressToBytes32(),
                address(usdcRouterB).addressToBytes32()
            )
        );
        _batchEnroll(
            usdtRouterA,
            _arr2(DESTINATION, ORIGIN),
            _arr2(
                address(usdcRouterB).addressToBytes32(),
                address(usdcRouterA).addressToBytes32()
            )
        );
        _batchEnroll(
            usdcRouterB,
            _arr2(ORIGIN, DESTINATION),
            _arr2(
                address(usdtRouterA).addressToBytes32(),
                address(usdtRouterB).addressToBytes32()
            )
        );

        // ---- Mint collateral to routers ----
        originUSDC.mintTo(address(usdcRouterA), 1_000_000e6);
        originUSDT.mintTo(address(usdtRouterA), 1_000_000e18);
        destUSDC.mintTo(address(usdcRouterB), 1_000_000e6);
        destUSDT.mintTo(address(usdtRouterB), 1_000_000e18);

        // ---- Mint tokens to users ----
        originUSDC.mintTo(ALICE, 100_000e6);
        originUSDT.mintTo(ALICE, 100_000e18);
        destUSDC.mintTo(BOB, 100_000e6);
        destUSDT.mintTo(BOB, 100_000e18);

        // ---- Approvals ----
        vm.prank(ALICE);
        originUSDC.approve(address(usdcRouterA), type(uint256).max);
        vm.prank(ALICE);
        originUSDT.approve(address(usdtRouterA), type(uint256).max);
        vm.prank(BOB);
        destUSDC.approve(address(usdcRouterB), type(uint256).max);
        vm.prank(BOB);
        destUSDT.approve(address(usdtRouterB), type(uint256).max);
    }

    function _deployRouter(
        address _token,
        uint256 _scaleNum,
        uint256 _scaleDen,
        address _mailbox
    ) internal returns (CrossCollateralRouter) {
        CrossCollateralRouter impl = new CrossCollateralRouter(
            _token,
            _scaleNum,
            _scaleDen,
            _mailbox
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20Collateral.initialize.selector,
                address(0), // hook (use mailbox default)
                address(0), // ism (use mailbox default)
                address(this) // owner
            )
        );
        return CrossCollateralRouter(address(proxy));
    }

    // ============ 1. Cross-chain same-stablecoin ============

    function test_crossChain_sameStablecoin() public {
        uint256 amount = 1000e6;
        uint256 bobBefore = destUSDC.balanceOf(BOB);

        vm.prank(ALICE);
        usdcRouterA.transferRemote(DESTINATION, BOB.addressToBytes32(), amount);
        env.processNextPendingMessage();

        assertEq(destUSDC.balanceOf(BOB), bobBefore + amount);
    }

    // ============ 2. Cross-chain cross-stablecoin ============

    function test_crossChain_crossStablecoin() public {
        uint256 amount = 1000e6; // 1000 USDC (6 dec)
        // USDC scaleNum=1e12 → canonical = amount * 1e12
        // USDT scaleNum=1 → local = canonical / 1 = amount * 1e12
        uint256 expectedUSDT = amount * USDC_SCALE_NUM;

        uint256 bobBefore = destUSDT.balanceOf(BOB);

        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(usdtRouterB).addressToBytes32()
        );
        env.processNextPendingMessage();

        assertEq(destUSDT.balanceOf(BOB), bobBefore + expectedUSDT);
    }

    // ============ 3. Same-chain swap ============

    function test_sameChain_swap() public {
        uint256 amount = 1000e6; // 1000 USDC
        uint256 expectedUSDT = amount * USDC_SCALE_NUM;

        uint256 aliceUSDTBefore = originUSDT.balanceOf(ALICE);

        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            amount,
            address(usdtRouterA).addressToBytes32()
        );

        assertEq(originUSDT.balanceOf(ALICE), aliceUSDTBefore + expectedUSDT);
    }

    function test_sameChain_swap_chargesFeeRecipient_notHookFees() public {
        uint256 amount = 10000e6;
        uint256 expectedFee = (amount * DEFAULT_FEE_BPS) / 10000;
        FixedQuoteHook hook = new FixedQuoteHook(7e6);
        usdcRouterA.setHook(address(hook));

        uint256 aliceBefore = originUSDC.balanceOf(ALICE);
        uint256 feeBalBefore = originUSDC.balanceOf(address(originUsdcFee));

        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            amount,
            address(usdtRouterA).addressToBytes32()
        );

        assertEq(
            originUSDC.balanceOf(address(originUsdcFee)),
            feeBalBefore + expectedFee
        );
        assertEq(
            aliceBefore - originUSDC.balanceOf(ALICE),
            amount + expectedFee
        );
        assertEq(originUSDC.balanceOf(address(hook)), 0);
    }

    function test_revert_sameChain_swap_targetRouterNotContract() public {
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = ORIGIN;
        routers[0] = address(0xdead).addressToBytes32();
        usdcRouterA.enrollCrossCollateralRouters(domains, routers);

        vm.prank(ALICE);
        vm.expectRevert("CCR: target router not contract");
        usdcRouterA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            1000e6,
            address(0xdead).addressToBytes32()
        );
    }

    function test_revert_sameChain_swap_nonzeroMsgValue() public {
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert("CCR: local transfer no msg.value");
        usdcRouterA.transferRemoteTo{value: 1}(
            ORIGIN,
            ALICE.addressToBytes32(),
            1000e6,
            address(usdtRouterA).addressToBytes32()
        );
    }

    // ============ 4. Fees on remote transfer ============

    function test_fees_remoteTransfer() public {
        uint256 amount = 10000e6;
        uint256 expectedFee = (amount * DEFAULT_FEE_BPS) / 10000; // 5 USDC

        uint256 feeBalBefore = originUSDC.balanceOf(address(originUsdcFee));

        vm.prank(ALICE);
        usdcRouterA.transferRemote(DESTINATION, BOB.addressToBytes32(), amount);

        assertEq(
            originUSDC.balanceOf(address(originUsdcFee)),
            feeBalBefore + expectedFee
        );
    }

    function test_transferRemote_withICrossCollateralFeeOnlyRecipient() public {
        MockRouterOnlyFee routerOnlyFee = new MockRouterOnlyFee(
            address(originUSDC),
            DEFAULT_FEE_BPS
        );
        usdcRouterA.setFeeRecipient(address(routerOnlyFee));

        uint256 amount = 10000e6;
        uint256 expectedFee = (amount * DEFAULT_FEE_BPS) / 10000;
        uint256 feeBalBefore = originUSDC.balanceOf(address(routerOnlyFee));

        vm.prank(ALICE);
        usdcRouterA.transferRemote(DESTINATION, BOB.addressToBytes32(), amount);

        assertEq(
            originUSDC.balanceOf(address(routerOnlyFee)),
            feeBalBefore + expectedFee
        );
    }

    // ============ 5. Fees on same-chain transfer ============

    function test_fees_sameChainTransfer() public {
        uint256 amount = 10000e6;
        uint256 expectedFee = (amount * DEFAULT_FEE_BPS) / 10000;

        uint256 feeBalBefore = originUSDC.balanceOf(address(originUsdcFee));

        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            amount,
            address(usdtRouterA).addressToBytes32()
        );

        assertEq(
            originUSDC.balanceOf(address(originUsdcFee)),
            feeBalBefore + expectedFee
        );
    }

    function test_fees_sameChainTransfer_noHookFeeCharged() public {
        uint256 amount = 10000e6;
        uint256 expectedFee = (amount * DEFAULT_FEE_BPS) / 10000;
        uint256 hookFee = 777e6;

        TestPostDispatchHook testHook = new TestPostDispatchHook();
        testHook.setFee(hookFee);
        usdcRouterA.setHook(address(testHook));

        uint256 aliceBalBefore = originUSDC.balanceOf(ALICE);
        uint256 feeBalBefore = originUSDC.balanceOf(address(originUsdcFee));

        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            amount,
            address(usdtRouterA).addressToBytes32()
        );

        uint256 aliceDebit = aliceBalBefore - originUSDC.balanceOf(ALICE);
        assertEq(aliceDebit, amount + expectedFee);
        assertEq(
            originUSDC.balanceOf(address(originUsdcFee)),
            feeBalBefore + expectedFee
        );
    }

    // ============ 6. Decimal scaling ============

    function test_decimalScaling_6to18() public {
        usdcRouterA.setFeeRecipient(address(0));
        usdtRouterA.setFeeRecipient(address(0));

        uint256 amount = 1e6; // 1 USDC
        uint256 expectedUSDT = 1e18;

        uint256 before = originUSDT.balanceOf(ALICE);

        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            amount,
            address(usdtRouterA).addressToBytes32()
        );

        assertEq(originUSDT.balanceOf(ALICE), before + expectedUSDT);
    }

    function test_decimalScaling_18to6() public {
        usdtRouterA.setFeeRecipient(address(0));
        usdcRouterA.setFeeRecipient(address(0));

        uint256 amount = 1e18; // 1 USDT
        uint256 expectedUSDC = 1e6;

        uint256 before = originUSDC.balanceOf(ALICE);

        vm.prank(ALICE);
        usdtRouterA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            amount,
            address(usdcRouterA).addressToBytes32()
        );

        assertEq(originUSDC.balanceOf(ALICE), before + expectedUSDC);
    }

    function test_decimalScaling_crossChain_roundTrip() public {
        usdcRouterA.setFeeRecipient(address(0));
        usdtRouterB.setFeeRecipient(address(0));
        usdtRouterA.setFeeRecipient(address(0));
        usdcRouterB.setFeeRecipient(address(0));

        uint256 amount = 1234e6; // 1234 USDC
        uint256 bobUSDTBefore = destUSDT.balanceOf(BOB);

        // USDC(6) → USDT(18) cross-chain
        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(usdtRouterB).addressToBytes32()
        );
        env.processNextPendingMessage();

        uint256 received = destUSDT.balanceOf(BOB) - bobUSDTBefore;
        assertEq(received, 1234e18);

        // Now BOB sends 1234e18 USDT(18) → USDC(6) back cross-chain
        uint256 aliceUSDCBefore = originUSDC.balanceOf(ALICE);
        vm.prank(BOB);
        destUSDT.approve(address(usdtRouterB), type(uint256).max);
        vm.prank(BOB);
        usdtRouterB.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            received,
            address(usdcRouterA).addressToBytes32()
        );
        env.processNextPendingMessageFromDestination();

        assertEq(originUSDC.balanceOf(ALICE), aliceUSDCBefore + 1234e6);
    }

    // ============ 7. Reject unauthorized router in handle ============

    function test_revert_handle_unauthorizedRouter() public {
        CrossCollateralRouter rogue = _deployRouter(
            address(destUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(destMailbox)
        );
        rogue.enrollRemoteRouter(
            ORIGIN,
            address(usdcRouterA).addressToBytes32()
        );

        destUSDC.mintTo(address(rogue), 100e6);
        vm.prank(address(destMailbox));
        vm.expectRevert("CCR: unauthorized router");
        usdcRouterB.handle(
            ORIGIN,
            address(rogue).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), uint256(100e18))
        );
    }

    // ============ 8. Direct-call handle security ============

    function test_revert_handle_directCall_unenrolledCaller() public {
        bytes memory tokenMsg = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e18)
        );
        vm.prank(UNAUTHORIZED);
        vm.expectRevert("CCR: unauthorized router");
        usdcRouterA.handle(ORIGIN, UNAUTHORIZED.addressToBytes32(), tokenMsg);
    }

    // ============ 9. Reject unauthorized in transferRemoteTo ============

    function test_revert_transferRemoteTo_unauthorizedRouter() public {
        vm.prank(ALICE);
        vm.expectRevert("CCR: unauthorized router");
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            1000e6,
            UNAUTHORIZED.addressToBytes32()
        );
    }

    // ============ 10. Owner-only router enrollment ============

    function test_revert_enrollRouters_nonOwner() public {
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = DESTINATION;
        routers[0] = UNAUTHORIZED.addressToBytes32();

        vm.prank(UNAUTHORIZED);
        vm.expectRevert("Ownable: caller is not the owner");
        usdcRouterA.enrollCrossCollateralRouters(domains, routers);
    }

    function test_revert_unenrollRouters_nonOwner() public {
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = DESTINATION;
        routers[0] = address(usdtRouterB).addressToBytes32();

        vm.prank(UNAUTHORIZED);
        vm.expectRevert("Ownable: caller is not the owner");
        usdcRouterA.unenrollCrossCollateralRouters(domains, routers);
    }

    // ============ 11. Bidirectional ============

    function test_bidirectional_destToOrigin() public {
        uint256 amount = 500e6;
        uint256 aliceBefore = originUSDC.balanceOf(ALICE);

        vm.prank(BOB);
        usdcRouterB.transferRemote(ORIGIN, ALICE.addressToBytes32(), amount);
        env.processNextPendingMessageFromDestination();

        assertEq(originUSDC.balanceOf(ALICE), aliceBefore + amount);
    }

    // ============ Router enrollment events ============

    function test_enrollRouters_emitsEvent() public {
        bytes32 router = address(0x42).addressToBytes32();
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = DESTINATION;
        routers[0] = router;

        vm.expectEmit(true, true, false, true);
        emit CrossCollateralRouter.CrossCollateralRouterEnrolled(
            DESTINATION,
            router
        );
        usdcRouterA.enrollCrossCollateralRouters(domains, routers);
        assertTrue(usdcRouterA.crossCollateralRouters(DESTINATION, router));
    }

    function test_unenrollRouters_emitsEvent() public {
        bytes32 router = address(usdtRouterB).addressToBytes32();
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = DESTINATION;
        routers[0] = router;

        vm.expectEmit(true, true, false, true);
        emit CrossCollateralRouter.CrossCollateralRouterUnenrolled(
            DESTINATION,
            router
        );
        usdcRouterA.unenrollCrossCollateralRouters(domains, routers);
        assertFalse(usdcRouterA.crossCollateralRouters(DESTINATION, router));
    }

    // ============ Quoting ============

    function test_quoteTransferRemoteTo() public view {
        Quote[] memory quotes = usdcRouterA.quoteTransferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            1000e6,
            address(usdtRouterB).addressToBytes32()
        );

        assertEq(quotes.length, 3);
        // [0] native gas quote
        assertEq(quotes[0].token, address(0));
        // [1] token amount + fee
        uint256 expectedFee = (1000e6 * DEFAULT_FEE_BPS) / 10000;
        assertEq(quotes[1].token, address(originUSDC));
        assertEq(quotes[1].amount, 1000e6 + expectedFee);
        // [2] external fee (0)
        assertEq(quotes[2].amount, 0);
    }

    function test_quoteTransferRemoteTo_withoutDefaultRouterEnrollment()
        public
    {
        // Remove default Router.sol mapping for DESTINATION while keeping
        // usdtRouterB enrolled via CrossCollateralRouter's per-domain set.
        usdcRouterA.unenrollRemoteRouter(DESTINATION);

        Quote[] memory quotes = usdcRouterA.quoteTransferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            1000e6,
            address(usdtRouterB).addressToBytes32()
        );

        assertEq(quotes.length, 3);
        assertEq(quotes[0].token, address(0));
        uint256 expectedFee = (1000e6 * DEFAULT_FEE_BPS) / 10000;
        assertEq(quotes[1].token, address(originUSDC));
        assertEq(quotes[1].amount, 1000e6 + expectedFee);
        assertEq(quotes[2].amount, 0);
    }

    function test_quoteTransferRemoteTo_revert_unauthorizedRouter() public {
        vm.expectRevert("CCR: unauthorized router");
        usdcRouterA.quoteTransferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            1000e6,
            address(0xdead).addressToBytes32()
        );
    }

    function test_quoteTransferRemoteTo_revert_sameDomain_targetRouterNotContract()
        public
    {
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = ORIGIN;
        routers[0] = address(0xdead).addressToBytes32();
        usdcRouterA.enrollCrossCollateralRouters(domains, routers);

        vm.expectRevert("CCR: target router not contract");
        usdcRouterA.quoteTransferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            1000e6,
            address(0xdead).addressToBytes32()
        );
    }

    function test_transferRemoteTo_withoutDefaultRouterEnrollment() public {
        usdcRouterA.setFeeRecipient(address(0));
        usdtRouterB.setFeeRecipient(address(0));
        usdcRouterA.unenrollRemoteRouter(DESTINATION);

        uint256 amount = 1234e6;
        uint256 bobBefore = destUSDT.balanceOf(BOB);

        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(usdtRouterB).addressToBytes32()
        );
        env.processNextPendingMessage();

        assertEq(destUSDT.balanceOf(BOB), bobBefore + 1234e18);
    }

    function test_transferRemoteTo_withHookFee_withoutDefaultRouterEnrollment()
        public
    {
        usdcRouterA.setFeeRecipient(address(0));
        usdtRouterB.setFeeRecipient(address(0));
        usdcRouterA.unenrollRemoteRouter(DESTINATION);

        uint256 amount = 1234e6;
        uint256 hookFee = 7e6;
        FixedQuoteHook hook = new FixedQuoteHook(hookFee);
        usdcRouterA.setHook(address(hook));
        usdcRouterA.setFeeHook(address(hook));

        uint256 aliceBefore = originUSDC.balanceOf(ALICE);
        uint256 bobBefore = destUSDT.balanceOf(BOB);

        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(usdtRouterB).addressToBytes32()
        );
        env.processNextPendingMessage();

        assertEq(destUSDT.balanceOf(BOB), bobBefore + 1234e18);
        assertEq(aliceBefore - originUSDC.balanceOf(ALICE), amount + hookFee);
    }

    // ============ Batch enrollment ============

    function test_enrollRouters_batch() public {
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory peers = new bytes32[](2);
        domains[0] = 99;
        domains[1] = 100;
        peers[0] = address(0x10).addressToBytes32();
        peers[1] = address(0x11).addressToBytes32();

        usdcRouterA.enrollCrossCollateralRouters(domains, peers);

        assertTrue(usdcRouterA.crossCollateralRouters(99, peers[0]));
        assertTrue(usdcRouterA.crossCollateralRouters(100, peers[1]));
    }

    function test_revert_enrollRouters_lengthMismatch() public {
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = 99;
        domains[1] = 100;
        routers[0] = address(0x10).addressToBytes32();

        vm.expectRevert("CCR: length mismatch");
        usdcRouterA.enrollCrossCollateralRouters(domains, routers);
    }

    function test_unenrollRouters_batch() public {
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory routers = new bytes32[](2);
        domains[0] = 99;
        domains[1] = 100;
        routers[0] = address(0x10).addressToBytes32();
        routers[1] = address(0x11).addressToBytes32();
        usdcRouterA.enrollCrossCollateralRouters(domains, routers);

        usdcRouterA.unenrollCrossCollateralRouters(domains, routers);

        assertFalse(usdcRouterA.crossCollateralRouters(99, routers[0]));
        assertFalse(usdcRouterA.crossCollateralRouters(100, routers[1]));
    }

    function test_revert_unenrollRouters_lengthMismatch() public {
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = 99;
        domains[1] = 100;
        routers[0] = address(0x10).addressToBytes32();

        vm.expectRevert("CCR: length mismatch");
        usdcRouterA.unenrollCrossCollateralRouters(domains, routers);
    }

    // ============ Enumeration ============

    function test_getCrossCollateralRouters_returnsCorrectList() public {
        CrossCollateralRouter fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(originMailbox)
        );

        bytes32 r1 = address(0xA1).addressToBytes32();
        bytes32 r2 = address(0xA2).addressToBytes32();
        bytes32 r3 = address(0xA3).addressToBytes32();

        uint32[] memory domains = new uint32[](3);
        bytes32[] memory routers = new bytes32[](3);
        domains[0] = 10;
        domains[1] = 10;
        domains[2] = 20;
        routers[0] = r1;
        routers[1] = r2;
        routers[2] = r3;

        fresh.enrollCrossCollateralRouters(domains, routers);

        bytes32[] memory list10 = fresh.getCrossCollateralRouters(10);
        assertEq(list10.length, 2);
        assertEq(list10[0], r1);
        assertEq(list10[1], r2);

        bytes32[] memory list20 = fresh.getCrossCollateralRouters(20);
        assertEq(list20.length, 1);
        assertEq(list20[0], r3);

        bytes32[] memory listEmpty = fresh.getCrossCollateralRouters(99);
        assertEq(listEmpty.length, 0);
    }

    function test_getCrossCollateralRouters_afterUnenroll() public {
        CrossCollateralRouter fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(originMailbox)
        );

        bytes32 r1 = address(0xB1).addressToBytes32();
        bytes32 r2 = address(0xB2).addressToBytes32();
        bytes32 r3 = address(0xB3).addressToBytes32();

        uint32[] memory domains = new uint32[](3);
        bytes32[] memory routers = new bytes32[](3);
        domains[0] = 10;
        domains[1] = 10;
        domains[2] = 10;
        routers[0] = r1;
        routers[1] = r2;
        routers[2] = r3;

        fresh.enrollCrossCollateralRouters(domains, routers);
        assertEq(fresh.getCrossCollateralRouters(10).length, 3);

        uint32[] memory ud = new uint32[](1);
        bytes32[] memory ur = new bytes32[](1);
        ud[0] = 10;
        ur[0] = r2;
        fresh.unenrollCrossCollateralRouters(ud, ur);

        bytes32[] memory list = fresh.getCrossCollateralRouters(10);
        assertEq(list.length, 2);
        assertEq(list[0], r1);
        assertEq(list[1], r3);
    }

    function test_enrollRouters_skipsDuplicates() public {
        CrossCollateralRouter fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(originMailbox)
        );

        bytes32 r1 = address(0xC1).addressToBytes32();
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory routers = new bytes32[](2);
        domains[0] = 10;
        domains[1] = 10;
        routers[0] = r1;
        routers[1] = r1;

        fresh.enrollCrossCollateralRouters(domains, routers);

        bytes32[] memory list = fresh.getCrossCollateralRouters(10);
        assertEq(list.length, 1);
        assertEq(list[0], r1);
    }

    function test_getCrossCollateralDomains_tracksEnrollAndUnenroll() public {
        CrossCollateralRouter fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(originMailbox)
        );

        // Initially empty
        assertEq(fresh.getCrossCollateralDomains().length, 0);

        // Enroll routers on domains 10 and 20
        bytes32 r1 = address(0xD1).addressToBytes32();
        bytes32 r2 = address(0xD2).addressToBytes32();
        bytes32 r3 = address(0xD3).addressToBytes32();

        uint32[] memory domains = new uint32[](3);
        bytes32[] memory routers = new bytes32[](3);
        domains[0] = 10;
        domains[1] = 10;
        domains[2] = 20;
        routers[0] = r1;
        routers[1] = r2;
        routers[2] = r3;
        fresh.enrollCrossCollateralRouters(domains, routers);

        uint32[] memory enrolled = fresh.getCrossCollateralDomains();
        assertEq(enrolled.length, 2);

        // Unenroll one router from domain 10 — domain should persist
        uint32[] memory ud = new uint32[](1);
        bytes32[] memory ur = new bytes32[](1);
        ud[0] = 10;
        ur[0] = r1;
        fresh.unenrollCrossCollateralRouters(ud, ur);
        assertEq(fresh.getCrossCollateralDomains().length, 2);

        // Unenroll last router from domain 10 — domain should be removed
        ur[0] = r2;
        fresh.unenrollCrossCollateralRouters(ud, ur);
        assertEq(fresh.getCrossCollateralDomains().length, 1);
        assertEq(fresh.getCrossCollateralDomains()[0], 20);
    }

    // ============ CrossCollateralRoutingFee Tests ============

    function test_routingFee_perRouterFee() public {
        LinearFee linearFee5bps = new LinearFee(
            address(originUSDC),
            10e6,
            10000e6,
            address(this)
        );
        LinearFee linearFee10bps = new LinearFee(
            address(originUSDC),
            20e6,
            10000e6,
            address(this)
        );

        CrossCollateralRoutingFee routingFee = new CrossCollateralRoutingFee(
            address(this)
        );
        uint32[] memory destinations = new uint32[](2);
        bytes32[] memory targetRouters = new bytes32[](2);
        address[] memory feeContracts = new address[](2);
        destinations[0] = DESTINATION;
        destinations[1] = DESTINATION;
        targetRouters[0] = address(usdtRouterB).addressToBytes32();
        targetRouters[1] = address(usdcRouterB).addressToBytes32();
        feeContracts[0] = address(linearFee5bps);
        feeContracts[1] = address(linearFee10bps);

        routingFee.setCrossCollateralRouterFeeContracts(
            destinations,
            targetRouters,
            feeContracts
        );

        usdcRouterA.setFeeRecipient(address(routingFee));

        uint256 amount = 10000e6;

        // Transfer to USDT router → 5bps fee
        uint256 feeBalBefore = originUSDC.balanceOf(address(routingFee));
        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(usdtRouterB).addressToBytes32()
        );
        uint256 fee5bps = originUSDC.balanceOf(address(routingFee)) -
            feeBalBefore;
        assertEq(fee5bps, 5e6, "5bps fee for USDT router");

        // Transfer to USDC router → 10bps fee
        feeBalBefore = originUSDC.balanceOf(address(routingFee));
        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(usdcRouterB).addressToBytes32()
        );
        uint256 fee10bps = originUSDC.balanceOf(address(routingFee)) -
            feeBalBefore;
        assertEq(fee10bps, 10e6, "10bps fee for USDC router");
    }

    function test_routingFee_fallbackToDestinationFee() public {
        LinearFee destFee = new LinearFee(
            address(originUSDC),
            10e6,
            10000e6,
            address(this)
        );
        CrossCollateralRoutingFee routingFee = new CrossCollateralRoutingFee(
            address(this)
        );
        uint32[] memory destinations = new uint32[](1);
        bytes32[] memory targetRouters = new bytes32[](1);
        address[] memory feeContracts = new address[](1);
        destinations[0] = DESTINATION;
        targetRouters[0] = routingFee.DEFAULT_ROUTER();
        feeContracts[0] = address(destFee);

        routingFee.setCrossCollateralRouterFeeContracts(
            destinations,
            targetRouters,
            feeContracts
        );

        usdcRouterA.setFeeRecipient(address(routingFee));

        uint256 amount = 10000e6;

        uint256 feeBalBefore = originUSDC.balanceOf(address(routingFee));
        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(usdtRouterB).addressToBytes32()
        );
        uint256 charged = originUSDC.balanceOf(address(routingFee)) -
            feeBalBefore;
        assertEq(charged, 5e6, "fallback to destination fee");
    }

    function test_routingFee_batchSetRouterFeeContracts() public {
        LinearFee linearFee5bps = new LinearFee(
            address(originUSDC),
            10e6,
            10000e6,
            address(this)
        );
        LinearFee linearFee10bps = new LinearFee(
            address(originUSDC),
            20e6,
            10000e6,
            address(this)
        );

        CrossCollateralRoutingFee routingFee = new CrossCollateralRoutingFee(
            address(this)
        );

        uint32[] memory destinations = new uint32[](2);
        bytes32[] memory targetRouters = new bytes32[](2);
        address[] memory feeContracts = new address[](2);
        destinations[0] = DESTINATION;
        destinations[1] = DESTINATION;
        targetRouters[0] = routingFee.DEFAULT_ROUTER();
        targetRouters[1] = address(usdtRouterB).addressToBytes32();
        feeContracts[0] = address(linearFee5bps);
        feeContracts[1] = address(linearFee10bps);

        routingFee.setCrossCollateralRouterFeeContracts(
            destinations,
            targetRouters,
            feeContracts
        );

        Quote[] memory defaultQuotes = routingFee.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            10000e6
        );
        assertEq(defaultQuotes.length, 1);
        assertEq(defaultQuotes[0].amount, 5e6, "default sentinel fee");

        Quote[] memory routerQuotes = routingFee.quoteTransferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            10000e6,
            address(usdtRouterB).addressToBytes32()
        );
        assertEq(routerQuotes.length, 1);
        assertEq(routerQuotes[0].amount, 10e6, "router-specific fee");
    }

    function test_routingFee_quoteMatchesCharge() public {
        LinearFee linearFee5bps = new LinearFee(
            address(originUSDC),
            10e6,
            10000e6,
            address(this)
        );
        CrossCollateralRoutingFee routingFee = new CrossCollateralRoutingFee(
            address(this)
        );
        uint32[] memory destinations = new uint32[](1);
        bytes32[] memory targetRouters = new bytes32[](1);
        address[] memory feeContracts = new address[](1);
        destinations[0] = DESTINATION;
        targetRouters[0] = address(usdtRouterB).addressToBytes32();
        feeContracts[0] = address(linearFee5bps);

        routingFee.setCrossCollateralRouterFeeContracts(
            destinations,
            targetRouters,
            feeContracts
        );
        usdcRouterA.setFeeRecipient(address(routingFee));

        uint256 amount = 10000e6;
        bytes32 targetRouter = address(usdtRouterB).addressToBytes32();

        // Get quote
        Quote[] memory quotes = usdcRouterA.quoteTransferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            targetRouter
        );
        uint256 quotedFee = quotes[1].amount - amount;

        // Execute transfer and measure actual fee
        uint256 feeBalBefore = originUSDC.balanceOf(address(routingFee));
        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            targetRouter
        );
        uint256 actualFee = originUSDC.balanceOf(address(routingFee)) -
            feeBalBefore;

        assertEq(quotedFee, actualFee, "quote matches actual charge");
    }

    function test_quoteTransferRemote_matchesTransferRemoteCharge() public {
        LinearFee defaultFee5bps = new LinearFee(
            address(originUSDC),
            10e6,
            10000e6,
            address(this)
        );
        LinearFee primaryRouterFee10bps = new LinearFee(
            address(originUSDC),
            20e6,
            10000e6,
            address(this)
        );
        CrossCollateralRoutingFee routingFee = new CrossCollateralRoutingFee(
            address(this)
        );

        uint32[] memory destinations = new uint32[](2);
        bytes32[] memory targetRouters = new bytes32[](2);
        address[] memory feeContracts = new address[](2);
        destinations[0] = DESTINATION;
        destinations[1] = DESTINATION;
        targetRouters[0] = routingFee.DEFAULT_ROUTER();
        targetRouters[1] = address(usdcRouterB).addressToBytes32();
        feeContracts[0] = address(defaultFee5bps);
        feeContracts[1] = address(primaryRouterFee10bps);

        routingFee.setCrossCollateralRouterFeeContracts(
            destinations,
            targetRouters,
            feeContracts
        );
        usdcRouterA.setFeeRecipient(address(routingFee));

        uint256 amount = 10000e6;
        Quote[] memory quotes = usdcRouterA.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            amount
        );
        uint256 quotedFee = quotes[1].amount - amount;

        uint256 feeBalBefore = originUSDC.balanceOf(address(routingFee));
        vm.prank(ALICE);
        usdcRouterA.transferRemote(DESTINATION, BOB.addressToBytes32(), amount);
        uint256 actualFee = originUSDC.balanceOf(address(routingFee)) -
            feeBalBefore;

        assertEq(quotedFee, 10e6, "quote uses primary router fee");
        assertEq(actualFee, 10e6, "charge uses primary router fee");
        assertEq(quotedFee, actualFee, "quote matches actual charge");
    }

    function test_quoteTransferRemote_usesScaledOutboundAmountForHookFee()
        public
    {
        MessageAmountQuoteHook hook = new MessageAmountQuoteHook();
        usdcRouterA.setHook(address(hook));
        usdcRouterA.setFeeHook(address(hook));
        usdcRouterA.setFeeRecipient(address(0));

        uint256 amount = 10_000e6;
        uint256 scaledAmount = amount * USDC_SCALE_NUM;
        originUSDC.mintTo(ALICE, scaledAmount);

        Quote[] memory quotes = usdcRouterA.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            amount
        );

        uint256 aliceBalanceBefore = originUSDC.balanceOf(ALICE);
        vm.prank(ALICE);
        usdcRouterA.transferRemote(DESTINATION, BOB.addressToBytes32(), amount);
        uint256 aliceBalanceAfter = originUSDC.balanceOf(ALICE);

        assertEq(
            quotes[0].amount,
            scaledAmount,
            "quote uses scaled outbound amount"
        );
        assertEq(
            aliceBalanceBefore - aliceBalanceAfter,
            amount + scaledAmount,
            "charge uses scaled outbound amount"
        );
    }

    function test_routingFee_claim() public {
        LinearFee linearFee5bps = new LinearFee(
            address(originUSDC),
            10e6,
            10000e6,
            address(this)
        );
        CrossCollateralRoutingFee routingFee = new CrossCollateralRoutingFee(
            address(this)
        );
        uint32[] memory destinations = new uint32[](1);
        bytes32[] memory targetRouters = new bytes32[](1);
        address[] memory feeContracts = new address[](1);
        destinations[0] = DESTINATION;
        targetRouters[0] = address(usdtRouterB).addressToBytes32();
        feeContracts[0] = address(linearFee5bps);
        routingFee.setCrossCollateralRouterFeeContracts(
            destinations,
            targetRouters,
            feeContracts
        );
        usdcRouterA.setFeeRecipient(address(routingFee));

        uint256 amount = 10000e6;
        vm.prank(ALICE);
        usdcRouterA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(usdtRouterB).addressToBytes32()
        );

        uint256 accrued = originUSDC.balanceOf(address(routingFee));
        assertGt(accrued, 0, "expected accrued routing fee");
        uint256 beneficiaryBefore = originUSDC.balanceOf(BOB);
        routingFee.claim(BOB, address(originUSDC));
        assertEq(originUSDC.balanceOf(address(routingFee)), 0);
        assertEq(originUSDC.balanceOf(BOB), beneficiaryBefore + accrued);
    }

    function test_revert_routingFee_claim_nonOwner() public {
        CrossCollateralRoutingFee routingFee = new CrossCollateralRoutingFee(
            address(this)
        );
        vm.prank(ALICE);
        vm.expectRevert("Ownable: caller is not the owner");
        routingFee.claim(ALICE, address(originUSDC));
    }

    // ============ Destination Gas for MC-enrolled domains ============

    function test_setDestinationGas_mcOnlyDomain() public {
        // Deploy a fresh MC router with NO default remote router for domain 99,
        // only MC-enrolled routers.
        CrossCollateralRouter fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(originMailbox)
        );
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = 99;
        routers[0] = address(0xAA).addressToBytes32();
        fresh.enrollCrossCollateralRouters(domains, routers);

        // Should succeed — domain 99 has MC-enrolled routers
        fresh.setDestinationGas(99, 200_000);
        assertEq(fresh.destinationGas(99), 200_000);
    }

    function test_setDestinationGas_defaultRouterDomain() public {
        // Domain with a default remote router should also work
        usdcRouterA.setDestinationGas(DESTINATION, 300_000);
        assertEq(usdcRouterA.destinationGas(DESTINATION), 300_000);
    }

    function test_revert_setDestinationGas_unknownDomain() public {
        vm.expectRevert("CCR: domain has no routers");
        usdcRouterA.setDestinationGas(999, 200_000);
    }

    function test_revert_setDestinationGas_localDomain() public {
        vm.expectRevert("CCR: no gas for local domain");
        usdcRouterA.setDestinationGas(ORIGIN, 200_000);
    }

    function test_revert_setDestinationGas_nonOwner() public {
        vm.prank(UNAUTHORIZED);
        vm.expectRevert("Ownable: caller is not the owner");
        usdcRouterA.setDestinationGas(DESTINATION, 200_000);
    }

    function test_setDestinationGas_batch() public {
        CrossCollateralRouter fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN,
            address(originMailbox)
        );
        // Enroll MC routers for domains 99 and 100
        uint32[] memory enrollDomains = new uint32[](2);
        bytes32[] memory enrollRouters = new bytes32[](2);
        enrollDomains[0] = 99;
        enrollDomains[1] = 100;
        enrollRouters[0] = address(0xAA).addressToBytes32();
        enrollRouters[1] = address(0xBB).addressToBytes32();
        fresh.enrollCrossCollateralRouters(enrollDomains, enrollRouters);

        GasRouter.GasRouterConfig[]
            memory configs = new GasRouter.GasRouterConfig[](2);
        configs[0] = GasRouter.GasRouterConfig({domain: 99, gas: 150_000});
        configs[1] = GasRouter.GasRouterConfig({domain: 100, gas: 250_000});

        fresh.setDestinationGas(configs);
        assertEq(fresh.destinationGas(99), 150_000);
        assertEq(fresh.destinationGas(100), 250_000);
    }

    function test_revert_setDestinationGas_batch_localDomain() public {
        GasRouter.GasRouterConfig[]
            memory configs = new GasRouter.GasRouterConfig[](1);
        configs[0] = GasRouter.GasRouterConfig({domain: ORIGIN, gas: 100_000});

        vm.expectRevert("CCR: no gas for local domain");
        usdcRouterA.setDestinationGas(configs);
    }

    function test_revert_setDestinationGas_batch_unknownDomain() public {
        GasRouter.GasRouterConfig[]
            memory configs = new GasRouter.GasRouterConfig[](1);
        configs[0] = GasRouter.GasRouterConfig({domain: 999, gas: 100_000});

        vm.expectRevert("CCR: domain has no routers");
        usdcRouterA.setDestinationGas(configs);
    }

    // ============ QuotedCalls + CrossCollateral ============

    uint256 constant QC_SIGNER_PK = 0xA11CE;
    uint256 constant QC_QUOTED_MAX_FEE = 5e6;
    uint256 constant QC_QUOTED_HALF_AMOUNT = 50_000e6;
    uint256 constant QC_TRANSFER_AMOUNT = 10_000e6;

    function _buildFeeQuoteInput(
        OffchainQuotedLinearFee _quotedFee,
        QuotedCalls _quotedCalls
    ) internal view returns (bytes memory) {
        uint48 now_ = uint48(block.timestamp);
        SignedQuote memory sq = SignedQuote({
            context: FeeQuoteContext.encode(
                DESTINATION,
                BOB.addressToBytes32(),
                QC_TRANSFER_AMOUNT
            ),
            data: FeeQuoteData.encode(QC_QUOTED_MAX_FEE, QC_QUOTED_HALF_AMOUNT),
            issuedAt: now_,
            expiry: now_, // transient
            salt: keccak256(
                abi.encodePacked(
                    ALICE,
                    bytes32(uint256(uint160(address(this))))
                )
            ),
            submitter: address(_quotedCalls)
        });

        bytes32 structHash = keccak256(
            abi.encode(
                _quotedFee.SIGNED_QUOTE_TYPEHASH(),
                keccak256(sq.context),
                keccak256(sq.data),
                sq.issuedAt,
                sq.expiry,
                sq.salt,
                sq.submitter
            )
        );
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("OffchainQuoter"),
                keccak256("1"),
                block.chainid,
                address(_quotedFee)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            QC_SIGNER_PK,
            ECDSA.toTypedDataHash(domainSep, structHash)
        );

        return
            abi.encode(
                address(_quotedFee),
                sq,
                abi.encodePacked(r, s, v),
                bytes32(uint256(uint160(address(this))))
            );
    }

    function test_quotedCalls_crossCollateralTransfer() public {
        address qcSigner = vm.addr(QC_SIGNER_PK);
        OffchainQuotedLinearFee quotedFee = new OffchainQuotedLinearFee(
            qcSigner,
            address(originUSDC),
            100e6, // immutable fallback maxFee
            100_000e6, // immutable fallback halfAmount
            address(this)
        );

        CrossCollateralRoutingFee routingFee = new CrossCollateralRoutingFee(
            address(this)
        );
        {
            uint32[] memory dests = new uint32[](1);
            bytes32[] memory targets = new bytes32[](1);
            address[] memory feeAddrs = new address[](1);
            dests[0] = DESTINATION;
            targets[0] = address(usdtRouterB).addressToBytes32();
            feeAddrs[0] = address(quotedFee);
            routingFee.setCrossCollateralRouterFeeContracts(
                dests,
                targets,
                feeAddrs
            );
        }
        usdcRouterA.setFeeRecipient(address(routingFee));

        QuotedCalls quotedCalls = new QuotedCalls(
            IAllowanceTransfer(address(0))
        );

        uint256 expectedFee = (QC_TRANSFER_AMOUNT * QC_QUOTED_MAX_FEE) /
            (2 * QC_QUOTED_HALF_AMOUNT);
        uint256 totalTokens = QC_TRANSFER_AMOUNT + expectedFee;

        bytes memory commands = new bytes(3);
        bytes[] memory inputs = new bytes[](3);

        commands[0] = bytes1(uint8(quotedCalls.SUBMIT_QUOTE()));
        inputs[0] = _buildFeeQuoteInput(quotedFee, quotedCalls);

        commands[1] = bytes1(uint8(quotedCalls.TRANSFER_FROM()));
        inputs[1] = abi.encode(address(originUSDC), totalTokens);

        commands[2] = bytes1(uint8(quotedCalls.TRANSFER_REMOTE_TO()));
        inputs[2] = abi.encode(
            address(usdcRouterA),
            DESTINATION,
            BOB.addressToBytes32(),
            QC_TRANSFER_AMOUNT,
            address(usdtRouterB).addressToBytes32(),
            uint256(0), // native value
            address(originUSDC),
            totalTokens
        );

        uint256 aliceBefore = originUSDC.balanceOf(ALICE);
        vm.startPrank(ALICE);
        originUSDC.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(originUSDC.balanceOf(ALICE), aliceBefore - totalTokens);
        assertEq(originUSDC.balanceOf(address(routingFee)), expectedFee);
        assertEq(originUSDC.balanceOf(address(quotedCalls)), 0);

        env.processNextPendingMessage();
        assertGt(destUSDT.balanceOf(BOB), 0);
    }

    // ============ Helpers ============

    function _batchEnroll(
        CrossCollateralRouter _router,
        uint32[] memory _domains,
        bytes32[] memory _routers
    ) internal {
        _router.enrollCrossCollateralRouters(_domains, _routers);
    }

    function _arr2(
        uint32 a,
        uint32 b
    ) internal pure returns (uint32[] memory arr) {
        arr = new uint32[](2);
        arr[0] = a;
        arr[1] = b;
    }

    function _arr2(
        bytes32 a,
        bytes32 b
    ) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
