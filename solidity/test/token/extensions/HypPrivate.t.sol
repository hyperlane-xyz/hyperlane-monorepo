// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../../contracts/mock/MockMailbox.sol";
import {TestPostDispatchHook} from "../../../contracts/test/TestPostDispatchHook.sol";
import {HypPrivate} from "../../../contracts/token/extensions/HypPrivate.sol";
import {HypPrivateCollateral} from "../../../contracts/token/extensions/HypPrivateCollateral.sol";
import {ERC20Test} from "../../../contracts/test/ERC20Test.sol";

/**
 * @title HypPrivateTest
 * @notice Comprehensive tests for HypPrivate base contract
 */
contract HypPrivateTest is Test {
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
    address constant PROXY_ADMIN = address(0x37);
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

    event RemoteRouterEnrolled(uint32 indexed domain, bytes32 router);

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

        // Deploy origin router
        originRouter = new HypPrivateCollateral(
            address(token),
            SCALE,
            address(originMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        originRouter.initialize(address(hook), address(0), address(this));

        // Deploy destination router
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
        assertEq(originRouter.aleoPrivacyHub(), ALEO_HUB);
        assertEq(originRouter.aleoDomain(), ALEO_DOMAIN);
        assertEq(originRouter.commitmentNonce(), 0);
    }

    function testConstructor_scale() public view {
        assertEq(originRouter.scale(), SCALE);
    }

    // ============ Commitment Computation Tests ============

    function testComputeCommitment() public {
        bytes32 secret = bytes32(uint256(0x123));
        bytes32 recipient = BOB.addressToBytes32();
        uint256 amount = 100e18;
        uint32 destination = DESTINATION_DOMAIN;
        bytes32 destRouter = address(destRouter).addressToBytes32();
        uint256 nonce = 0;

        bytes32 commitment = originRouter.computeCommitment(
            secret,
            recipient,
            amount,
            destination,
            destRouter,
            nonce
        );

        // Commitment should be deterministic
        bytes32 expected = keccak256(
            abi.encode(
                secret,
                recipient,
                amount,
                destination,
                destRouter,
                nonce
            )
        );
        assertEq(commitment, expected);
    }

    function testComputeCommitment_differentInputsProduceDifferentCommitments()
        public
    {
        bytes32 secret = bytes32(uint256(0x123));
        bytes32 recipient = BOB.addressToBytes32();
        uint256 amount = 100e18;
        uint32 destination = DESTINATION_DOMAIN;
        bytes32 destRouter = address(destRouter).addressToBytes32();

        bytes32 commitment1 = originRouter.computeCommitment(
            secret,
            recipient,
            amount,
            destination,
            destRouter,
            0
        );

        bytes32 commitment2 = originRouter.computeCommitment(
            secret,
            recipient,
            amount,
            destination,
            destRouter,
            1
        );

        assertTrue(commitment1 != commitment2);
    }

    function testComputeCommitment_fuzz(
        bytes32 secret,
        address recipient,
        uint128 amount,
        uint32 destination,
        address destRouterAddr,
        uint32 nonce
    ) public {
        bytes32 recipientBytes = recipient.addressToBytes32();
        bytes32 destRouter = destRouterAddr.addressToBytes32();

        bytes32 commitment = originRouter.computeCommitment(
            secret,
            recipientBytes,
            amount,
            destination,
            destRouter,
            nonce
        );

        // Verify it's deterministic
        bytes32 expected = keccak256(
            abi.encode(
                secret,
                recipientBytes,
                amount,
                destination,
                destRouter,
                nonce
            )
        );
        assertEq(commitment, expected);
    }

    // ============ Router Enrollment Tests ============

    function testEnrollRemoteRouter() public {
        vm.expectEmit(true, false, false, true);
        emit RemoteRouterEnrolled(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        assertEq(
            originRouter.getRemoteRouter(DESTINATION_DOMAIN),
            address(destRouter).addressToBytes32()
        );
    }

    function testEnrollRemoteRouter_revert_notOwner() public {
        vm.prank(ALICE);
        vm.expectRevert("Ownable: caller is not the owner");
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );
    }

    function testEnrollRemoteRouter_revert_aleoDomain() public {
        vm.expectRevert("HypPrivate: cannot enroll Aleo");
        originRouter.enrollRemoteRouter(ALEO_DOMAIN, ALEO_HUB);
    }

    function testEnrollRemoteRouter_revert_zeroRouter() public {
        vm.expectRevert("HypPrivate: zero router");
        originRouter.enrollRemoteRouter(DESTINATION_DOMAIN, bytes32(0));
    }

    function testEnrollRemoteRouter_canOverwrite() public {
        bytes32 router1 = address(0x1111).addressToBytes32();
        bytes32 router2 = address(0x2222).addressToBytes32();

        originRouter.enrollRemoteRouter(DESTINATION_DOMAIN, router1);
        assertEq(originRouter.getRemoteRouter(DESTINATION_DOMAIN), router1);

        originRouter.enrollRemoteRouter(DESTINATION_DOMAIN, router2);
        assertEq(originRouter.getRemoteRouter(DESTINATION_DOMAIN), router2);
    }

    // ============ Deposit Tests ============

    function testDepositPrivate() public {
        // Enroll destination router
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        // Compute expected commitment
        bytes32 expectedCommitment = originRouter.computeCommitment(
            secret,
            BOB.addressToBytes32(),
            amount,
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32(),
            0
        );

        vm.prank(ALICE);
        token.approve(address(originRouter), amount);

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

        // Verify commitment matches
        assertEq(commitment, expectedCommitment);
        assertTrue(messageId != bytes32(0));

        // Verify nonce incremented
        assertEq(originRouter.commitmentNonce(), 1);

        // Verify tokens transferred
        assertEq(token.balanceOf(address(originRouter)), 100_000e18 + amount);
        assertEq(token.balanceOf(ALICE), 10_000e18 - amount);
    }

    function testDepositPrivate_revert_destinationNotEnrolled() public {
        bytes32 secret = bytes32(uint256(0x123));

        vm.prank(ALICE);
        token.approve(address(originRouter), 100e18);

        vm.prank(ALICE);
        vm.expectRevert("HypPrivate: router not enrolled");
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            100e18
        );
    }

    function testDepositPrivate_revert_aleoDomain() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));

        vm.prank(ALICE);
        token.approve(address(originRouter), 100e18);

        vm.prank(ALICE);
        vm.expectRevert("HypPrivate: cannot deposit to Aleo");
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            ALEO_DOMAIN,
            BOB.addressToBytes32(),
            100e18
        );
    }

    function testDepositPrivate_revert_zeroAmount() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));

        vm.prank(ALICE);
        token.approve(address(originRouter), 0);

        vm.prank(ALICE);
        vm.expectRevert("HypPrivate: zero amount");
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            0
        );
    }

    function testDepositPrivate_revert_amountExceedsU128() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = uint256(type(uint128).max) + 1;

        // Mint large amount
        token.mint(amount);
        token.approve(address(originRouter), amount);

        vm.expectRevert("HypPrivate: amount exceeds u128");
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );
    }

    function testDepositPrivate_messageFormat() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        vm.prank(ALICE);
        token.approve(address(originRouter), amount);

        vm.prank(ALICE);
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );

        // Get message from mailbox
        bytes memory message = aleoMailbox.inboundMessages(0);

        // Skip Hyperlane message header (extract body)
        bytes memory body;
        assembly {
            let bodyStart := add(message, 77) // Skip 77-byte header
            let bodyLen := sub(mload(message), 77)
            body := mload(0x40)
            mstore(body, bodyLen)
            for {
                let i := 0
            } lt(i, bodyLen) {
                i := add(i, 32)
            } {
                mstore(add(body, add(32, i)), mload(add(bodyStart, i)))
            }
            mstore(0x40, add(body, add(32, bodyLen)))
        }

        // Verify message is 141 bytes
        assertEq(body.length, 141);
    }

    // ============ Receive/Handle Tests ============

    function testHandle_receiveFromAleo() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        // Encode message: [recipient][amount][commitment][padding(13)]
        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(), // 32 bytes
            amount, // 32 bytes
            commitment, // 32 bytes
            new bytes(13) // 13 bytes padding
        );

        assertEq(message.length, 109);

        uint256 balanceBefore = token.balanceOf(BOB);

        vm.expectEmit(true, true, false, true);
        emit ReceivedFromPrivacyHub(commitment, BOB, amount);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        // Verify tokens transferred
        assertEq(token.balanceOf(BOB), balanceBefore + amount);

        // Verify commitment marked as used
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    function testHandle_revert_wrongOrigin() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        vm.prank(address(destMailbox));
        vm.expectRevert("No router enrolled for domain: 1");
        destRouter.handle(ORIGIN_DOMAIN, ALEO_HUB, message);
    }

    function testHandle_revert_wrongSender() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        vm.prank(address(destMailbox));
        vm.expectRevert("Enrolled router does not match sender");
        destRouter.handle(ALEO_DOMAIN, bytes32(uint256(0x999)), message);
    }

    function testHandle_revert_invalidMessageLength() public {
        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e18),
            keccak256("test")
        ); // 96 bytes, not 109

        vm.prank(address(destMailbox));
        vm.expectRevert("HypPrivate: invalid message length");
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);
    }

    function testHandle_revert_commitmentAlreadyUsed() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        // Process first time
        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        // Try to process again
        vm.prank(address(destMailbox));
        vm.expectRevert("HypPrivate: commitment already used");
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);
    }

    function testHandle_multipleCommitments() public {
        bytes32 commitment1 = keccak256("commitment1");
        bytes32 commitment2 = keccak256("commitment2");
        uint256 amount = 50e18;

        bytes memory message1 = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment1,
            new bytes(13)
        );

        bytes memory message2 = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment2,
            new bytes(13)
        );

        uint256 balanceBefore = token.balanceOf(BOB);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message1);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message2);

        assertEq(token.balanceOf(BOB), balanceBefore + amount * 2);
        assertTrue(destRouter.isCommitmentUsed(commitment1));
        assertTrue(destRouter.isCommitmentUsed(commitment2));
    }

    // ============ Query Function Tests ============

    function testIsCommitmentUsed() public {
        bytes32 commitment = keccak256("test_commitment");
        assertFalse(destRouter.isCommitmentUsed(commitment));

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e18),
            commitment,
            new bytes(13)
        );

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    function testGetRemoteRouter() public {
        assertEq(originRouter.getRemoteRouter(DESTINATION_DOMAIN), bytes32(0));

        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        assertEq(
            originRouter.getRemoteRouter(DESTINATION_DOMAIN),
            address(destRouter).addressToBytes32()
        );
    }

    // ============ Nonce Tests ============

    function testCommitmentNonce_incrementsOnDeposit() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        assertEq(originRouter.commitmentNonce(), 0);

        vm.prank(ALICE);
        token.approve(address(originRouter), 300e18);

        vm.prank(ALICE);
        originRouter.depositPrivate{value: requiredValue}(
            bytes32(uint256(1)),
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            100e18
        );
        assertEq(originRouter.commitmentNonce(), 1);

        vm.prank(ALICE);
        originRouter.depositPrivate{value: requiredValue}(
            bytes32(uint256(2)),
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            100e18
        );
        assertEq(originRouter.commitmentNonce(), 2);

        vm.prank(ALICE);
        originRouter.depositPrivate{value: requiredValue}(
            bytes32(uint256(3)),
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            100e18
        );
        assertEq(originRouter.commitmentNonce(), 3);
    }

    // ============ Edge Case Tests ============

    function testDepositPrivate_maxU128Amount() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        uint256 amount = uint256(type(uint128).max);
        token.mint(amount);
        token.approve(address(originRouter), amount);

        originRouter.depositPrivate{value: requiredValue}(
            bytes32(uint256(0x123)),
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );

        // Should succeed with max u128
        assertEq(originRouter.commitmentNonce(), 1);
    }

    function testHandle_zeroAmount() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 0;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        // Should not revert, just transfer 0 tokens
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }
}
