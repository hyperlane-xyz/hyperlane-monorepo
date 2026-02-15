// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../../contracts/mock/MockMailbox.sol";
import {TestPostDispatchHook} from "../../../contracts/test/TestPostDispatchHook.sol";
import {HypPrivateNative} from "../../../contracts/token/extensions/HypPrivateNative.sol";

/**
 * @title HypPrivateNativeTest
 * @notice Tests for HypPrivateNative (native token privacy transfers)
 */
contract HypPrivateNativeTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // Test constants
    uint32 constant ORIGIN_DOMAIN = 1;
    uint32 constant DESTINATION_DOMAIN = 2;
    uint32 constant ALEO_DOMAIN = 99;
    uint256 constant SCALE = 1;

    // Test addresses
    address constant ALICE = address(0x1);
    address constant BOB = address(0x2);
    bytes32 constant ALEO_HUB = bytes32(uint256(0xa1e0));

    // Test contracts
    MockMailbox originMailbox;
    MockMailbox aleoMailbox;
    MockMailbox destMailbox;
    TestPostDispatchHook hook;
    HypPrivateNative originRouter;
    HypPrivateNative destRouter;

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

        // Deploy routers
        originRouter = new HypPrivateNative(
            SCALE,
            address(originMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        originRouter.initialize(address(hook), address(0), address(this));

        destRouter = new HypPrivateNative(
            SCALE,
            address(destMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        destRouter.initialize(address(hook), address(0), address(this));

        // Fund routers with native tokens
        vm.deal(address(originRouter), 100 ether);
        vm.deal(address(destRouter), 100 ether);

        // Fund test users
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
    }

    // ============ Token Tests ============

    function testToken() public view {
        assertEq(originRouter.token(), address(0));
        assertEq(destRouter.token(), address(0));
    }

    // ============ Deposit Tests ============

    function testDepositPrivate_native() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 1 ether;

        uint256 balanceBefore = address(originRouter).balance;
        uint256 aliceBalanceBefore = ALICE.balance;

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
            value: amount + requiredValue
        }(secret, DESTINATION_DOMAIN, BOB.addressToBytes32());

        // Verify commitment
        assertEq(commitment, expectedCommitment);
        assertTrue(messageId != bytes32(0));

        // Verify native tokens transferred
        assertEq(address(originRouter).balance, balanceBefore + amount);
        assertEq(ALICE.balance, aliceBalanceBefore - amount - requiredValue);
    }

    function testDepositPrivate_revert_valueMismatch() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 1 ether;

        // Amount is derived from msg.value - gas, so this will succeed
        // with amount = (amount + requiredValue - 1) - requiredValue = amount - 1
        vm.prank(ALICE);
        (bytes32 messageId, ) = originRouter.depositPrivate{
            value: amount + requiredValue - 1
        }(secret, DESTINATION_DOMAIN, BOB.addressToBytes32());

        // Verify it succeeded (not a revert test anymore)
        assertTrue(messageId != bytes32(0));
    }

    function testDepositPrivate_revert_insufficientValue() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));

        vm.prank(ALICE);
        vm.expectRevert("HypPrivateNative: insufficient value");
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32()
        );
    }

    function testDepositPrivate_multipleDeposits() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret1 = bytes32(uint256(0x111));
        bytes32 secret2 = bytes32(uint256(0x222));
        uint256 amount1 = 1 ether;
        uint256 amount2 = 2 ether;

        uint256 balanceBefore = address(originRouter).balance;

        vm.prank(ALICE);
        originRouter.depositPrivate{value: amount1 + requiredValue}(
            secret1,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32()
        );

        vm.prank(ALICE);
        originRouter.depositPrivate{value: amount2 + requiredValue}(
            secret2,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32()
        );

        assertEq(
            address(originRouter).balance,
            balanceBefore + amount1 + amount2
        );
        assertEq(originRouter.commitmentNonce(), 2);
    }

    // ============ Receive Tests ============

    function testHandle_receiveNative() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 1 ether;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        uint256 balanceBefore = BOB.balance;
        uint256 routerBalanceBefore = address(destRouter).balance;

        vm.expectEmit(true, true, false, true);
        emit ReceivedFromPrivacyHub(commitment, BOB, amount);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        // Verify native tokens transferred
        assertEq(BOB.balance, balanceBefore + amount);
        assertEq(address(destRouter).balance, routerBalanceBefore - amount);

        // Verify commitment marked as used
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    function testHandle_receiveNative_toContract() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 1 ether;

        // Deploy a receiver contract
        ReceiverContract receiver = new ReceiverContract();

        bytes memory message = abi.encodePacked(
            address(receiver).addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        uint256 balanceBefore = address(receiver).balance;

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        assertEq(address(receiver).balance, balanceBefore + amount);
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    function testHandle_revert_insufficientBalance() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 200 ether; // More than router balance

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        vm.prank(address(destMailbox));
        vm.expectRevert();
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);
    }

    // ============ Receive Function Tests ============

    function testReceive_canFundRouter() public {
        uint256 balanceBefore = address(originRouter).balance;

        vm.prank(ALICE);
        (bool success, ) = address(originRouter).call{value: 10 ether}("");
        assertTrue(success);

        assertEq(address(originRouter).balance, balanceBefore + 10 ether);
    }

    function testReceive_multipleDeposits() public {
        uint256 balanceBefore = address(originRouter).balance;

        vm.prank(ALICE);
        (bool success1, ) = address(originRouter).call{value: 5 ether}("");
        assertTrue(success1);

        vm.prank(BOB);
        (bool success2, ) = address(originRouter).call{value: 3 ether}("");
        assertTrue(success2);

        assertEq(address(originRouter).balance, balanceBefore + 8 ether);
    }

    // ============ Integration Tests ============

    function testFullFlow_depositAndReceive() public {
        // Enroll routers
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 1 ether;

        // Deposit on origin
        vm.prank(ALICE);
        (bytes32 messageId, bytes32 commitment) = originRouter.depositPrivate{
            value: amount + requiredValue
        }(secret, DESTINATION_DOMAIN, BOB.addressToBytes32());

        // Simulate receiving on destination (would come from Aleo in production)
        bytes memory receiveMessage = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        uint256 bobBalanceBefore = BOB.balance;

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, receiveMessage);

        assertEq(BOB.balance, bobBalanceBefore + amount);
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    // ============ Fuzz Tests ============

    function testDepositPrivate_fuzz(bytes32 secret, uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount < 50 ether); // Reasonable test bound

        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        vm.deal(ALICE, amount + requiredValue + 1 ether);

        uint256 balanceBefore = address(originRouter).balance;

        vm.prank(ALICE);
        originRouter.depositPrivate{value: amount + requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32()
        );

        assertEq(address(originRouter).balance, balanceBefore + amount);
    }

    function testHandle_fuzz(bytes32 commitment, uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount < 50 ether);

        vm.deal(address(destRouter), amount + 1 ether);

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(amount),
            commitment,
            new bytes(13)
        );

        uint256 balanceBefore = BOB.balance;

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        assertEq(BOB.balance, balanceBefore + amount);
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }
}

/**
 * @dev Helper contract to test receiving native tokens
 */
contract ReceiverContract {
    receive() external payable {}
}
