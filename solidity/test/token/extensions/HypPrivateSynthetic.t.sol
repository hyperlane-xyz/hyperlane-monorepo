// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../../contracts/mock/MockMailbox.sol";
import {TestPostDispatchHook} from "../../../contracts/test/TestPostDispatchHook.sol";
import {HypPrivateSynthetic} from "../../../contracts/token/extensions/HypPrivateSynthetic.sol";

/**
 * @title HypPrivateSyntheticTest
 * @notice Tests for HypPrivateSynthetic (synthetic token privacy transfers)
 */
contract HypPrivateSyntheticTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // Test constants
    uint32 constant ORIGIN_DOMAIN = 1;
    uint32 constant DESTINATION_DOMAIN = 2;
    uint32 constant ALEO_DOMAIN = 99;
    uint8 constant DECIMALS = 18;
    uint256 constant SCALE = 1;
    uint256 constant INITIAL_SUPPLY = 1_000_000e18;
    string constant NAME = "Synthetic Token";
    string constant SYMBOL = "SYN";

    // Test addresses
    address constant ALICE = address(0x1);
    address constant BOB = address(0x2);
    bytes32 constant ALEO_HUB = bytes32(uint256(0xa1e0));

    // Test contracts
    MockMailbox originMailbox;
    MockMailbox aleoMailbox;
    MockMailbox destMailbox;
    TestPostDispatchHook hook;
    HypPrivateSynthetic originRouter;
    HypPrivateSynthetic destRouter;

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

    event Transfer(address indexed from, address indexed to, uint256 value);

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

        // Deploy origin router (with initial supply)
        originRouter = new HypPrivateSynthetic(
            DECIMALS,
            SCALE,
            address(originMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        originRouter.initialize(
            NAME,
            SYMBOL,
            INITIAL_SUPPLY,
            address(hook),
            address(0),
            address(this)
        );

        // Deploy destination router (no initial supply)
        destRouter = new HypPrivateSynthetic(
            DECIMALS,
            SCALE,
            address(destMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        destRouter.initialize(
            NAME,
            SYMBOL,
            0,
            address(hook),
            address(0),
            address(this)
        );

        // Fund test users
        originRouter.transfer(ALICE, 10_000e18);
        originRouter.transfer(BOB, 10_000e18);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
    }

    // ============ Constructor & Initialization Tests ============

    function testConstructor() public view {
        assertEq(originRouter.decimals(), DECIMALS);
        assertEq(originRouter.token(), address(originRouter));
    }

    function testInitialize() public view {
        assertEq(originRouter.name(), NAME);
        assertEq(originRouter.symbol(), SYMBOL);
        assertEq(originRouter.totalSupply(), INITIAL_SUPPLY);
        assertEq(
            originRouter.balanceOf(address(this)),
            INITIAL_SUPPLY - 20_000e18
        );
    }

    function testInitialize_zeroSupply() public view {
        assertEq(destRouter.totalSupply(), 0);
    }

    function testInitialize_revert_alreadyInitialized() public {
        vm.expectRevert("Initializable: contract is already initialized");
        originRouter.initialize(
            NAME,
            SYMBOL,
            INITIAL_SUPPLY,
            address(hook),
            address(0),
            address(this)
        );
    }

    // ============ ERC20 Functionality Tests ============

    function testERC20_transfer() public {
        uint256 amount = 100e18;
        uint256 aliceBalanceBefore = originRouter.balanceOf(ALICE);
        uint256 bobBalanceBefore = originRouter.balanceOf(BOB);

        vm.prank(ALICE);
        originRouter.transfer(BOB, amount);

        assertEq(originRouter.balanceOf(ALICE), aliceBalanceBefore - amount);
        assertEq(originRouter.balanceOf(BOB), bobBalanceBefore + amount);
    }

    function testERC20_approve() public {
        uint256 amount = 100e18;

        vm.prank(ALICE);
        originRouter.approve(BOB, amount);

        assertEq(originRouter.allowance(ALICE, BOB), amount);
    }

    function testERC20_transferFrom() public {
        uint256 amount = 100e18;

        vm.prank(ALICE);
        originRouter.approve(BOB, amount);

        uint256 aliceBalanceBefore = originRouter.balanceOf(ALICE);
        address recipient = address(0x999);

        vm.prank(BOB);
        originRouter.transferFrom(ALICE, recipient, amount);

        assertEq(originRouter.balanceOf(ALICE), aliceBalanceBefore - amount);
        assertEq(originRouter.balanceOf(recipient), amount);
        assertEq(originRouter.allowance(ALICE, BOB), 0);
    }

    // ============ Deposit Tests (Burn) ============

    function testDepositPrivate_burnsSyntheticTokens() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        uint256 totalSupplyBefore = originRouter.totalSupply();
        uint256 aliceBalanceBefore = originRouter.balanceOf(ALICE);

        vm.prank(ALICE);
        originRouter.approve(address(originRouter), amount);

        bytes32 expectedCommitment = originRouter.computeCommitment(
            secret,
            BOB.addressToBytes32(),
            amount,
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32(),
            0
        );

        vm.expectEmit(true, true, false, true);
        emit Transfer(ALICE, address(0), amount);

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

        // Verify tokens burned
        assertEq(originRouter.totalSupply(), totalSupplyBefore - amount);
        assertEq(originRouter.balanceOf(ALICE), aliceBalanceBefore - amount);
    }

    function testDepositPrivate_revert_withNativeValue() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        vm.prank(ALICE);
        originRouter.approve(address(originRouter), amount);

        vm.prank(ALICE);
        vm.expectRevert("HypPrivateSynthetic: no native token");
        originRouter.depositPrivate{value: 1 ether + requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );
    }

    function testDepositPrivate_revert_insufficientBalance() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100_000e18; // More than ALICE has

        vm.prank(ALICE);
        originRouter.approve(address(originRouter), amount);

        vm.prank(ALICE);
        vm.expectRevert("ERC20: burn amount exceeds balance");
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );
    }

    // ============ Receive Tests (Mint) ============

    function testHandle_mintsSyntheticTokens() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        uint256 totalSupplyBefore = destRouter.totalSupply();
        uint256 bobBalanceBefore = destRouter.balanceOf(BOB);

        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), BOB, amount);

        vm.expectEmit(true, true, false, true);
        emit ReceivedFromPrivacyHub(commitment, BOB, amount);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        // Verify tokens minted
        assertEq(destRouter.totalSupply(), totalSupplyBefore + amount);
        assertEq(destRouter.balanceOf(BOB), bobBalanceBefore + amount);

        // Verify commitment marked as used
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    function testHandle_mintToNewAddress() public {
        address newRecipient = address(0x9999);
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        bytes memory message = abi.encodePacked(
            newRecipient.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        assertEq(destRouter.balanceOf(newRecipient), 0);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        assertEq(destRouter.balanceOf(newRecipient), amount);
    }

    function testHandle_multipleMintsIncreaseTotalSupply() public {
        bytes32 commitment1 = keccak256("commitment1");
        bytes32 commitment2 = keccak256("commitment2");
        uint256 amount1 = 100e18;
        uint256 amount2 = 200e18;

        bytes memory message1 = abi.encodePacked(
            BOB.addressToBytes32(),
            amount1,
            commitment1,
            new bytes(13)
        );

        bytes memory message2 = abi.encodePacked(
            BOB.addressToBytes32(),
            amount2,
            commitment2,
            new bytes(13)
        );

        uint256 totalSupplyBefore = destRouter.totalSupply();

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message1);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message2);

        assertEq(
            destRouter.totalSupply(),
            totalSupplyBefore + amount1 + amount2
        );
    }

    // ============ Integration Tests ============

    function testFullFlow_burnAndMint() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        uint256 originTotalSupplyBefore = originRouter.totalSupply();
        uint256 destTotalSupplyBefore = destRouter.totalSupply();

        // Burn on origin
        vm.prank(ALICE);
        originRouter.approve(address(originRouter), amount);

        vm.prank(ALICE);
        (, bytes32 commitment) = originRouter.depositPrivate{
            value: requiredValue
        }(secret, DESTINATION_DOMAIN, BOB.addressToBytes32(), amount);

        // Verify burn
        assertEq(originRouter.totalSupply(), originTotalSupplyBefore - amount);

        // Simulate mint on destination
        bytes memory receiveMessage = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, receiveMessage);

        // Verify mint
        assertEq(destRouter.totalSupply(), destTotalSupplyBefore + amount);
        assertEq(destRouter.balanceOf(BOB), amount);
    }

    function testFullFlow_globalSupplyConservation() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        bytes32 secret = bytes32(uint256(0x123));
        uint256 amount = 100e18;

        uint256 originSupplyBefore = originRouter.totalSupply();
        uint256 destSupplyBefore = destRouter.totalSupply();
        uint256 globalSupplyBefore = originSupplyBefore + destSupplyBefore;

        // Deposit (burn on origin)
        vm.prank(ALICE);
        originRouter.approve(address(originRouter), amount);

        vm.prank(ALICE);
        (, bytes32 commitment) = originRouter.depositPrivate{
            value: requiredValue
        }(secret, DESTINATION_DOMAIN, BOB.addressToBytes32(), amount);

        // Receive (mint on dest)
        bytes memory receiveMessage = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, receiveMessage);

        // Verify global supply decreased by amount (burned but not minted)
        uint256 globalSupplyAfter = originRouter.totalSupply() +
            destRouter.totalSupply();

        // In real flow, origin burns and dest mints same amount
        // Here we simulate: origin burned 100, dest minted 100
        assertEq(globalSupplyAfter, globalSupplyBefore);
    }

    // ============ Multiple Transfers Test ============

    function testMultipleDepositsAndReceives() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        uint256 amount1 = 100e18;
        uint256 amount2 = 200e18;

        // First transfer
        vm.prank(ALICE);
        originRouter.approve(address(originRouter), 500e18);

        vm.prank(ALICE);
        (, bytes32 commitment1) = originRouter.depositPrivate{
            value: requiredValue
        }(
            bytes32(uint256(1)),
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount1
        );

        // Second transfer
        vm.prank(ALICE);
        (, bytes32 commitment2) = originRouter.depositPrivate{
            value: requiredValue
        }(
            bytes32(uint256(2)),
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount2
        );

        // Receive first
        bytes memory msg1 = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e18),
            commitment1,
            new bytes(13)
        );
        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, msg1);

        // Receive second
        bytes memory msg2 = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(200e18),
            commitment2,
            new bytes(13)
        );
        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, msg2);

        assertEq(destRouter.balanceOf(BOB), 300e18);
    }

    // ============ Edge Cases ============

    function testDepositPrivate_burnEntireBalance() public {
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        uint256 aliceBalance = originRouter.balanceOf(ALICE);

        vm.prank(ALICE);
        originRouter.approve(address(originRouter), aliceBalance);

        vm.prank(ALICE);
        originRouter.depositPrivate{value: requiredValue}(
            bytes32(uint256(0x123)),
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            aliceBalance
        );

        assertEq(originRouter.balanceOf(ALICE), 0);
    }

    function testHandle_mintZeroAmount() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 0;

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        uint256 totalSupplyBefore = destRouter.totalSupply();

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        // Should not revert, just mint 0 tokens
        assertEq(destRouter.totalSupply(), totalSupplyBefore);
        assertTrue(destRouter.isCommitmentUsed(commitment));
    }

    function testHandle_mintToZeroAddress_reverts() public {
        bytes32 commitment = keccak256("test_commitment");
        uint256 amount = 100e18;

        bytes memory message = abi.encodePacked(
            address(0).addressToBytes32(),
            amount,
            commitment,
            new bytes(13)
        );

        vm.prank(address(destMailbox));
        vm.expectRevert("ERC20: mint to the zero address");
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);
    }

    // ============ Decimals Tests ============

    function testDecimals() public view {
        assertEq(originRouter.decimals(), DECIMALS);
        assertEq(destRouter.decimals(), DECIMALS);
    }

    function testDecimals_differentValues() public {
        HypPrivateSynthetic router6 = new HypPrivateSynthetic(
            6,
            SCALE,
            address(originMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        router6.initialize(
            "USDC",
            "USDC",
            0,
            address(hook),
            address(0),
            address(this)
        );

        assertEq(router6.decimals(), 6);

        HypPrivateSynthetic router8 = new HypPrivateSynthetic(
            8,
            SCALE,
            address(originMailbox),
            ALEO_HUB,
            ALEO_DOMAIN
        );
        router8.initialize(
            "WBTC",
            "WBTC",
            0,
            address(hook),
            address(0),
            address(this)
        );

        assertEq(router8.decimals(), 8);
    }

    // ============ Fuzz Tests ============

    function testDepositPrivate_fuzz(bytes32 secret, uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount <= 1000e18);

        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destRouter).addressToBytes32()
        );

        // Mint tokens to test account
        vm.prank(address(this));
        originRouter.transfer(address(0x9999), amount);

        vm.prank(address(0x9999));
        originRouter.approve(address(originRouter), amount);

        uint256 totalSupplyBefore = originRouter.totalSupply();

        vm.prank(address(0x9999));
        originRouter.depositPrivate{value: requiredValue}(
            secret,
            DESTINATION_DOMAIN,
            BOB.addressToBytes32(),
            amount
        );

        assertEq(originRouter.totalSupply(), totalSupplyBefore - amount);
    }

    function testHandle_fuzz(bytes32 commitment, uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount < type(uint128).max / 2);

        bytes memory message = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(amount),
            commitment,
            new bytes(13)
        );

        uint256 totalSupplyBefore = destRouter.totalSupply();
        uint256 bobBalanceBefore = destRouter.balanceOf(BOB);

        vm.prank(address(destMailbox));
        destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

        assertEq(destRouter.totalSupply(), totalSupplyBefore + amount);
        assertEq(destRouter.balanceOf(BOB), bobBalanceBefore + amount);
    }
}
