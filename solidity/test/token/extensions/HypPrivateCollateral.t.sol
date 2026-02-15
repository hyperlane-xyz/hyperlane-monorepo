// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../../contracts/mock/MockMailbox.sol";
import {TestPostDispatchHook} from "../../../contracts/test/TestPostDispatchHook.sol";
import {HypPrivateCollateral} from "../../../contracts/token/extensions/HypPrivateCollateral.sol";
import {ERC20Test} from "../../../contracts/test/ERC20Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title HypPrivateCollateralTest
 * @notice Tests for HypPrivateCollateral (ERC20 privacy transfers with rebalancing)
 */
contract HypPrivateCollateralTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // Test constants
    uint32 constant ORIGIN_DOMAIN = 1;
    uint32 constant DESTINATION_DOMAIN = 2;
    uint32 constant ALEO_DOMAIN = 99;
    uint256 constant SCALE = 1;
    uint256 constant TOTAL_SUPPLY = 1_000_000e18;

    // Test addresses
    address constant ALICE = address(0x1);
    address constant BOB = address(0x2);
    bytes32 constant ALEO_HUB = bytes32(uint256(0xa1e0));

    // Test contracts
    MockMailbox originMailbox;
    MockMailbox aleoMailbox;
    MockMailbox destMailbox;
    TestPostDispatchHook hook;
    ERC20Test token;
    HypPrivateCollateral originRouter;
    HypPrivateCollateral destRouter;

    uint256 requiredValue;

    // Events
    event DepositToPrivacyHub(
        address indexed depositor,
        bytes32 indexed commitment,
        uint32 finalDestination,
        bytes32 destinationRouter,
        uint256 amount
    );

    event ReceivedFromPrivacyHub(
        bytes32 indexed commitment,
        address indexed recipient,
        uint256 amount
    );

    event CollateralSent(uint32 indexed destination, uint256 amount);
    event CollateralReceived(uint32 indexed origin, uint256 amount);

    function setUp() public {
        // Deploy mailboxes
        originMailbox = new MockMailbox(ORIGIN_DOMAIN);
        aleoMailbox = new MockMailbox(ALEO_DOMAIN);
        destMailbox = new MockMailbox(DESTINATION_DOMAIN);

        // Connect mailboxes
        originMailbox.addRemoteMailbox(ALEO_DOMAIN, aleoMailbox);
        originMailbox.addRemoteMailbox(DESTINATION_DOMAIN, destMailbox);
        aleoMailbox.addRemoteMailbox(ORIGIN_DOMAIN, originMailbox);
        aleoMailbox.addRemoteMailbox(DESTINATION_DOMAIN, destMailbox);
        destMailbox.addRemoteMailbox(ORIGIN_DOMAIN, originMailbox);
        destMailbox.addRemoteMailbox(ALEO_DOMAIN, aleoMailbox);

        // Setup hooks
        hook = new TestPostDispatchHook();
        originMailbox.setDefaultHook(address(hook));
        originMailbox.setRequiredHook(address(hook));
        aleoMailbox.setDefaultHook(address(hook));
        aleoMailbox.setRequiredHook(address(hook));
        destMailbox.setDefaultHook(address(hook));
        destMailbox.setRequiredHook(address(hook));

        requiredValue = hook.quoteDispatch("", "");

        // Deploy ERC20 token
        token = new ERC20Test("Test Token", "TEST", TOTAL_SUPPLY, 18);

        // Deploy routers
        originRouter = new HypPrivateCollateral(
            address(token),
            SCALE,
            address(originMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        originRouter.initialize(address(hook), address(0), address(this));

        destRouter = new HypPrivateCollateral(
            address(token),
            SCALE,
            address(destMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        destRouter.initialize(address(hook), address(0), address(this));

        // Fund routers with collateral
        token.transfer(address(originRouter), 100_000e18);
        token.transfer(address(destRouter), 100_000e18);

        // Fund test users
        token.transfer(ALICE, 10_000e18);
        token.transfer(BOB, 10_000e18);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
    }

    // ============ Constructor Tests ============

    function testConstructor() public view {
        assertEq(address(originRouter.wrappedToken()), address(token));
        assertEq(originRouter.token(), address(token));
    }

    function testConstructor_revert_zeroToken() public {
        vm.expectRevert("HypPrivateCollateral: zero token");
        new HypPrivateCollateral(
            address(0),
            SCALE,
            address(originMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
    }

    // ============ Deposit Tests ============

    function testDepositPrivate_erc20() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        uint256 routerBalanceBefore = token.balanceOf(address(originRouter));
        uint256 aliceBalanceBefore = token.balanceOf(ALICE);

        vm.prank(ALICE);
        token.approve(address(originRouter), amount);

        bytes32 expectedCommitment = originRouter.computeCommitment(
            secret,
            BOB.addressToBytes32(),
            amount,
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32(),
            0
        );

        vm.expectEmit(true, true, false, true);
        emit DepositToPrivacyHub(
            ALICE,
            expectedCommitment,
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32(),
            amount
        );

        vm.prank(ALICE);
        (bytes32 messageId, bytes32 commitment) = originRouter.depositPrivate{
            value: requiredValue
        }(secret, DESTINATION_DOMAIN, BOB.addressToBytes32(), amount);

        // Verify commitment
        assertEq(commitment, expectedCommitment);
        assertTrue(messageId != bytes32(0));

        // Verify tokens transferred
        assertEq(
            token.balanceOf(address(originRouter)),
            routerBalanceBefore + amount
        );
        assertEq(token.balanceOf(ALICE), aliceBalanceBefore - amount);
    }

    function testDepositPrivate_revert_withNativeValue() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        vm.prank(ALICE);
        token.approve(address(originRouter), amount);

        vm.prank(ALICE);
        vm.expectRevert("HypPrivateCollateral: no native token");
        originRouter.depositPrivate{value: 1 ether + requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );
    }

    function testDepositPrivate_revert_insufficientApproval() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        vm.prank(ALICE);
        token.approve(address(originRouter), amount - 1);

        vm.prank(ALICE);
        vm.expectRevert("ERC20: insufficient allowance");
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );
    }

    // ============ Receive Tests ============

    function testHandle_receiveERC20() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        uint256 balanceBefore = token.balanceOf(BOB);
        uint256 routerBalanceBefore = token.balanceOf(address(destRouter));

        vm.expectEmit(true, true, false, true);
        emit ReceivedFromPrivacyHub(commitment, BOB, amount);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        // Verify tokens transferred
        assertEq(token.balanceOf(BOB), balanceBefore + amount);
        assertEq(
            token.balanceOf(address(destRouter)),
            routerBalanceBefore - amount
        );

        // Verify commitment marked as used
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    // ============ Rebalancing Tests ============

    function testTransferRemoteCollateral() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
        destRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        uint256 amount = 10_000e18;
        uint256 originBalanceBefore = token.balanceOf(address(originRouter));
        uint256 destBalanceBefore = token.balanceOf(address(destRouter));

        vm.expectEmit(true, false, false, true);
        emit CollateralSent(DESTINATION_DOMAIN, amount);

        bytes32 messageId = originRouter.transferRemoteCollateral(
            DESTINATION_DOMAIN,
            amount
        );

        assertTrue(messageId != bytes32(0));

        // Process the message
        vm.expectEmit(true, false, false, true);
        emit CollateralReceived(ORIGIN_DOMAIN, amount);

        destMailbox.processNextInboundMessage();

        // Verify balances unchanged (collateral doesn't physically move)
        assertEq(token.balanceOf(address(originRouter)), originBalanceBefore);
        assertEq(token.balanceOf(address(destRouter)), destBalanceBefore);
    }

    function testTransferRemoteCollateral_revert_notOwner() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        vm.prank(ALICE);
        vm.expectRevert("Ownable: caller is not the owner");
        originRouter.transferRemoteCollateral(DESTINATION_DOMAIN, 1000e18);
    }

    function testTransferRemoteCollateral_revert_toAleo() public {
        vm.expectRevert("HypPrivateCollateral: cannot rebalance to Aleo");
        originRouter.transferRemoteCollateral(ALEO_DOMAIN, 1000e18);
    }

    function testTransferRemoteCollateral_revert_routerNotEnrolled() public {
        vm.expectRevert("HypPrivateCollateral: router not enrolled");
        originRouter.transferRemoteCollateral(DESTINATION_DOMAIN, 1000e18);
    }

    function testTransferRemoteCollateral_revert_insufficientBalance() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        uint256 balance = token.balanceOf(address(originRouter));
        uint256 amount = balance + 1;

        vm.expectRevert("HypPrivateCollateral: insufficient collateral");
        originRouter.transferRemoteCollateral(DESTINATION_DOMAIN, amount);
    }

    function testTransferRemoteCollateral_multipleTransfers() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
        destRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        uint256 amount1 = 5_000e18;
        uint256 amount2 = 3_000e18;

        // First transfer
        originRouter.transferRemoteCollateral(DESTINATION_DOMAIN, amount1);
        destMailbox.processNextInboundMessage();

        // Second transfer
        originRouter.transferRemoteCollateral(DESTINATION_DOMAIN, amount2);
        destMailbox.processNextInboundMessage();

        // Both should succeed
    }

    // ============ Handle Rebalancing Tests ============

    function testHandle_rebalanceMessage() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
        destRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        uint256 amount = 5_000e18;

        // Encode rebalance message (type = 0x01)
        bytes memory message = abi.encodePacked(bytes1(0x01), amount);

        vm.expectEmit(true, false, false, true);
        emit CollateralReceived(ORIGIN_DOMAIN, amount);

        vm.prank(address(destMailbox));
        destRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            message
        );
    }

    function testHandle_rebalanceMessage_revert_unenrolledRouter() public {
        uint256 amount = 5_000e18;
        bytes memory message = abi.encodePacked(bytes1(0x01), amount);

        vm.prank(address(destMailbox));
        vm.expectRevert("No router enrolled for domain: 1");
        destRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            message
        );
    }

    function testHandle_rebalanceMessage_vs_privateTransfer() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
        destRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        // Test rebalance message
        uint256 rebalanceAmount = 5_000e18;
        bytes memory rebalanceMsg = abi.encodePacked(
            bytes1(0x01),
            rebalanceAmount
        );

        vm.prank(address(destMailbox));
        destRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            rebalanceMsg
        );

        // Test private transfer message (from Aleo)
        bytes32 commitment = keccak256("test_commitment");
        uint256 privateAmount = 100e18;
        bytes memory privateMsg = abi.encodePacked(
            BOB.addressToBytes32(),
            privateAmount,
            commitment,
            new bytes(13)
        );

        uint256 bobBalanceBefore = token.balanceOf(BOB);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, privateMsg);

        // Verify private transfer worked
        assertEq(token.balanceOf(BOB), bobBalanceBefore + privateAmount);
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    // ============ Query Function Tests ============

    function testCollateralBalance() public view {
        uint256 balance = originRouter.collateralBalance();
        assertEq(balance, token.balanceOf(address(originRouter)));
        assertEq(balance, 100_000e18);
    }

    function testCollateralBalance_afterDeposit() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        uint256 amount = 100e18;
        vm.prank(ALICE);
        token.approve(address(originRouter), amount);

        uint256 balanceBefore = originRouter.collateralBalance();

        vm.prank(ALICE);
        originRouter.depositPrivate{value: requiredValue}(
            bytes32(uint256(0x123)),
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );

        assertEq(originRouter.collateralBalance(), balanceBefore + amount);
    }

    function testCollateralBalance_afterReceive() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        uint256 balanceBefore = destRouter.collateralBalance();

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        assertEq(destRouter.collateralBalance(), balanceBefore - amount);
    }

    // ============ Integration Tests ============

    function testFullFlow_depositAndReceive() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        // Deposit on origin
        vm.prank(ALICE);
        token.approve(address(originRouter), amount);

        vm.prank(ALICE);
        (, bytes32 commitment) = originRouter.depositPrivate{
            value: requiredValue
        }(secret, DESTINATION_DOMAIN, BOB.addressToBytes32(), amount);

        // Simulate receiving on destination
        bytes memory receiveMessage = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        uint256 bobBalanceBefore = token.balanceOf(BOB);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, receiveMessage);

        assertEq(token.balanceOf(BOB), bobBalanceBefore + amount);
    }

    function testFullFlow_rebalancing() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
        destRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        uint256 rebalanceAmount = 10_000e18;

        // Move collateral from origin to dest
        originRouter.transferRemoteCollateral(
            DESTINATION_DOMAIN,
            rebalanceAmount
        );
        destMailbox.processNextInboundMessage();

        // Move collateral back from dest to origin
        vm.prank(address(destRouter.owner()));
        destRouter.transferRemoteCollateral(ORIGIN_DOMAIN, rebalanceAmount / 2);
        originMailbox.processNextInboundMessage();

        // Both transfers should succeed
    }

    // ============ Edge Cases ============

    function testTransferRemoteCollateral_entireBalance() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
        destRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        uint256 balance = token.balanceOf(address(originRouter));

        originRouter.transferRemoteCollateral(DESTINATION_DOMAIN, balance);
        destMailbox.processNextInboundMessage();

        // Should succeed
        assertEq(token.balanceOf(address(originRouter)), balance);
    }

    function testHandle_zeroAmountRebalance() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
        destRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        bytes memory message = abi.encodePacked(bytes1(0x01), uint256(0));

        vm.prank(address(destMailbox));
        destRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            message
        );

        // Should not revert
    }

    // ============ Fuzz Tests ============

    function testDepositPrivate_fuzz(bytes32 secret, uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount <= 1000e18);

        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        token.mint(amount);
        token.approve(address(originRouter), amount);

        uint256 balanceBefore = token.balanceOf(address(originRouter));

        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );

        assertEq(
            token.balanceOf(address(originRouter)),
            balanceBefore + amount
        );
    }

    function testTransferRemoteCollateral_fuzz(uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount <= 100_000e18);

        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
        destRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        originRouter.transferRemoteCollateral(DESTINATION_DOMAIN, amount);
        destMailbox.processNextInboundMessage();

        // Should succeed without errors
    }
}
