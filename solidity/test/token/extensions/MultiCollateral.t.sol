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

import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {MockHyperlaneEnvironment} from "../../../contracts/mock/MockHyperlaneEnvironment.sol";
import {MockMailbox} from "../../../contracts/mock/MockMailbox.sol";
import {ERC20Test} from "../../../contracts/test/ERC20Test.sol";
import {ITokenFee, Quote} from "../../../contracts/interfaces/ITokenBridge.sol";

import {MultiCollateral} from "../../../contracts/token/extensions/MultiCollateral.sol";
import {HypERC20Collateral} from "../../../contracts/token/HypERC20Collateral.sol";

/// @notice Mock fee contract: fixed percentage fee (same as CollateralAdapter.t.sol).
contract MockDepositFee is ITokenFee {
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
}

contract MultiCollateralTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    uint32 internal constant ORIGIN = 1;
    uint32 internal constant DESTINATION = 2;

    uint256 internal constant USDC_SCALE = 1e12; // 6 → 18 decimals
    uint256 internal constant USDT_SCALE = 1; // 18 → 18 decimals
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
    MultiCollateral internal usdcRouterA; // domain 1, USDC
    MultiCollateral internal usdtRouterA; // domain 1, USDT
    MultiCollateral internal usdcRouterB; // domain 2, USDC
    MultiCollateral internal usdtRouterB; // domain 2, USDT

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
            USDC_SCALE,
            address(originMailbox)
        );
        usdtRouterA = _deployRouter(
            address(originUSDT),
            USDT_SCALE,
            address(originMailbox)
        );
        usdcRouterB = _deployRouter(
            address(destUSDC),
            USDC_SCALE,
            address(destMailbox)
        );
        usdtRouterB = _deployRouter(
            address(destUSDT),
            USDT_SCALE,
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
        uint256 _scale,
        address _mailbox
    ) internal returns (MultiCollateral) {
        MultiCollateral impl = new MultiCollateral(_token, _scale, _mailbox);
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
        return MultiCollateral(address(proxy));
    }

    // ============ 1. Cross-chain same-stablecoin ============

    function test_crossChain_sameStablecoin() public {
        uint256 amount = 1000e6;
        // Fee is additive: sender pays amount + fee, recipient gets full amount
        uint256 bobBefore = destUSDC.balanceOf(BOB);

        vm.prank(ALICE);
        usdcRouterA.transferRemote(DESTINATION, BOB.addressToBytes32(), amount);
        env.processNextPendingMessage();

        assertEq(destUSDC.balanceOf(BOB), bobBefore + amount);
    }

    // ============ 2. Cross-chain cross-stablecoin ============

    function test_crossChain_crossStablecoin() public {
        uint256 amount = 1000e6; // 1000 USDC (6 dec)
        // Fee is additive: sender pays amount + fee, full amount dispatched
        // USDC scale=1e12 → canonical = amount * 1e12
        // USDT scale=1 → local = canonical / 1 = amount * 1e12
        uint256 expectedUSDT = amount * USDC_SCALE;

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
        // Fee is additive: sender pays amount + fee, full amount swapped
        // canonical = amount * 1e12; USDT local = canonical / 1
        uint256 expectedUSDT = amount * USDC_SCALE;

        uint256 aliceUSDTBefore = originUSDT.balanceOf(ALICE);

        vm.prank(ALICE);
        usdcRouterA.localTransferTo(address(usdtRouterA), ALICE, amount);

        assertEq(originUSDT.balanceOf(ALICE), aliceUSDTBefore + expectedUSDT);
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

    // ============ 5. Fees on local transfer ============

    function test_fees_localTransfer() public {
        uint256 amount = 10000e6;
        uint256 expectedFee = (amount * DEFAULT_FEE_BPS) / 10000;

        uint256 feeBalBefore = originUSDC.balanceOf(address(originUsdcFee));

        vm.prank(ALICE);
        usdcRouterA.localTransferTo(address(usdtRouterA), ALICE, amount);

        assertEq(
            originUSDC.balanceOf(address(originUsdcFee)),
            feeBalBefore + expectedFee
        );
    }

    // ============ 6. Decimal scaling ============

    function test_decimalScaling_6to18() public {
        // Disable fees for clean math
        usdcRouterA.setFeeRecipient(address(0));
        usdtRouterA.setFeeRecipient(address(0));

        uint256 amount = 1e6; // 1 USDC
        // canonical = 1e6 * 1e12 = 1e18
        // USDT inbound = 1e18 / 1 = 1e18
        uint256 expectedUSDT = 1e18;

        uint256 before = originUSDT.balanceOf(ALICE);

        vm.prank(ALICE);
        usdcRouterA.localTransferTo(address(usdtRouterA), ALICE, amount);

        assertEq(originUSDT.balanceOf(ALICE), before + expectedUSDT);
    }

    function test_decimalScaling_18to6() public {
        // Disable fees for clean math
        usdtRouterA.setFeeRecipient(address(0));
        usdcRouterA.setFeeRecipient(address(0));

        uint256 amount = 1e18; // 1 USDT
        // canonical = 1e18 * 1 = 1e18
        // USDC inbound = 1e18 / 1e12 = 1e6
        uint256 expectedUSDC = 1e6;

        uint256 before = originUSDC.balanceOf(ALICE);

        vm.prank(ALICE);
        usdtRouterA.localTransferTo(address(usdcRouterA), ALICE, amount);

        assertEq(originUSDC.balanceOf(ALICE), before + expectedUSDC);
    }

    function test_decimalScaling_crossChain_roundTrip() public {
        // Disable fees
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

        // canonical = 1234e6 * 1e12 = 1234e18; USDT local = 1234e18
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

        // canonical = 1234e18 * 1 = 1234e18; USDC local = 1234e18 / 1e12 = 1234e6
        assertEq(originUSDC.balanceOf(ALICE), aliceUSDCBefore + 1234e6);
    }

    // ============ 7. Reject unauthorized router in handle ============

    function test_revert_handle_unauthorizedRouter() public {
        // Deploy an unregistered router on destination
        MultiCollateral rogue = _deployRouter(
            address(destUSDC),
            USDC_SCALE,
            address(destMailbox)
        );
        rogue.enrollRemoteRouter(
            ORIGIN,
            address(usdcRouterA).addressToBytes32()
        );

        // Dispatch a message from rogue to usdcRouterB
        // Since rogue is not enrolled on usdcRouterB, it should revert
        destUSDC.mintTo(address(rogue), 100e6);
        vm.prank(address(destMailbox));
        vm.expectRevert("MC: unauthorized router");
        usdcRouterB.handle(
            ORIGIN,
            address(rogue).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), uint256(100e18))
        );
    }

    // ============ 8. Reject unauthorized in localTransferTo ============

    function test_revert_localTransferTo_unauthorizedRouter() public {
        vm.prank(ALICE);
        vm.expectRevert("MC: not local router");
        usdcRouterA.localTransferTo(UNAUTHORIZED, ALICE, 1000e6);
    }

    // ============ 9. Reject unauthorized in transferRemoteTo ============

    function test_revert_transferRemoteTo_unauthorizedRouter() public {
        vm.prank(ALICE);
        vm.expectRevert("MC: unauthorized router");
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
        usdcRouterA.enrollRouters(domains, routers);
    }

    function test_revert_unenrollRouters_nonOwner() public {
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = DESTINATION;
        routers[0] = address(usdtRouterB).addressToBytes32();

        vm.prank(UNAUTHORIZED);
        vm.expectRevert("Ownable: caller is not the owner");
        usdcRouterA.unenrollRouters(domains, routers);
    }

    // ============ 11. Bidirectional ============

    function test_bidirectional_destToOrigin() public {
        uint256 amount = 500e6;
        // Fee is additive: recipient gets full amount
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
        emit MultiCollateral.RouterEnrolled(DESTINATION, router);
        usdcRouterA.enrollRouters(domains, routers);
        assertTrue(usdcRouterA.enrolledRouters(DESTINATION, router));
    }

    function test_unenrollRouters_emitsEvent() public {
        bytes32 router = address(usdtRouterB).addressToBytes32();
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = DESTINATION;
        routers[0] = router;

        vm.expectEmit(true, true, false, true);
        emit MultiCollateral.RouterUnenrolled(DESTINATION, router);
        usdcRouterA.unenrollRouters(domains, routers);
        assertFalse(usdcRouterA.enrolledRouters(DESTINATION, router));
    }

    // ============ receiveLocalSwap unauthorized ============

    function test_revert_receiveLocalSwap_unauthorized() public {
        vm.prank(UNAUTHORIZED);
        vm.expectRevert("MC: not local router");
        usdcRouterA.receiveLocalSwap(1000e18, ALICE);
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

    // ============ Batch enrollment ============

    function test_enrollRouters_batch() public {
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory peers = new bytes32[](2);
        domains[0] = 99;
        domains[1] = 100;
        peers[0] = address(0x10).addressToBytes32();
        peers[1] = address(0x11).addressToBytes32();

        usdcRouterA.enrollRouters(domains, peers);

        assertTrue(usdcRouterA.enrolledRouters(99, peers[0]));
        assertTrue(usdcRouterA.enrolledRouters(100, peers[1]));
    }

    function test_revert_enrollRouters_lengthMismatch() public {
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = 99;
        domains[1] = 100;
        routers[0] = address(0x10).addressToBytes32();

        vm.expectRevert("MC: length mismatch");
        usdcRouterA.enrollRouters(domains, routers);
    }

    function test_unenrollRouters_batch() public {
        // First enroll two routers
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory routers = new bytes32[](2);
        domains[0] = 99;
        domains[1] = 100;
        routers[0] = address(0x10).addressToBytes32();
        routers[1] = address(0x11).addressToBytes32();
        usdcRouterA.enrollRouters(domains, routers);

        // Unenroll both
        usdcRouterA.unenrollRouters(domains, routers);

        assertFalse(usdcRouterA.enrolledRouters(99, routers[0]));
        assertFalse(usdcRouterA.enrolledRouters(100, routers[1]));
    }

    function test_revert_unenrollRouters_lengthMismatch() public {
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = 99;
        domains[1] = 100;
        routers[0] = address(0x10).addressToBytes32();

        vm.expectRevert("MC: length mismatch");
        usdcRouterA.unenrollRouters(domains, routers);
    }

    // ============ Enumeration ============

    function test_getEnrolledRouters_returnsCorrectList() public {
        // Deploy fresh router to test from clean state
        MultiCollateral fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE,
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

        fresh.enrollRouters(domains, routers);

        bytes32[] memory list10 = fresh.getEnrolledRouters(10);
        assertEq(list10.length, 2);
        assertEq(list10[0], r1);
        assertEq(list10[1], r2);

        bytes32[] memory list20 = fresh.getEnrolledRouters(20);
        assertEq(list20.length, 1);
        assertEq(list20[0], r3);

        // Empty domain
        bytes32[] memory listEmpty = fresh.getEnrolledRouters(99);
        assertEq(listEmpty.length, 0);
    }

    function test_getEnrolledRouters_afterUnenroll() public {
        MultiCollateral fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE,
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

        fresh.enrollRouters(domains, routers);
        assertEq(fresh.getEnrolledRouters(10).length, 3);

        // Unenroll middle one (r2)
        uint32[] memory ud = new uint32[](1);
        bytes32[] memory ur = new bytes32[](1);
        ud[0] = 10;
        ur[0] = r2;
        fresh.unenrollRouters(ud, ur);

        bytes32[] memory list = fresh.getEnrolledRouters(10);
        assertEq(list.length, 2);
        // swap-and-pop: r3 moved to r2's position
        assertEq(list[0], r1);
        assertEq(list[1], r3);
    }

    function test_enrollRouters_skipsDuplicates() public {
        MultiCollateral fresh = _deployRouter(
            address(originUSDC),
            USDC_SCALE,
            address(originMailbox)
        );

        bytes32 r1 = address(0xC1).addressToBytes32();
        uint32[] memory domains = new uint32[](2);
        bytes32[] memory routers = new bytes32[](2);
        domains[0] = 10;
        domains[1] = 10;
        routers[0] = r1;
        routers[1] = r1;

        fresh.enrollRouters(domains, routers);

        bytes32[] memory list = fresh.getEnrolledRouters(10);
        assertEq(list.length, 1);
        assertEq(list[0], r1);
    }

    // ============ Helpers ============

    function _batchEnroll(
        MultiCollateral _router,
        uint32[] memory _domains,
        bytes32[] memory _routers
    ) internal {
        _router.enrollRouters(_domains, _routers);
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
