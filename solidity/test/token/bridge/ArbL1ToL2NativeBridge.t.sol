// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {ArbL1ToL2NativeBridge} from "contracts/token/bridge/ArbL1ToL2NativeBridge.sol";
import {IInbox} from "contracts/interfaces/arbitrum/IInbox.sol";
import {Quote} from "contracts/interfaces/ITokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

contract MockInbox {
    event InboxMessageDelivered(uint256 indexed messageNum, bytes data);

    address public lastDestAddr;
    uint256 public lastValue;
    uint256 public messageNum;

    function depositEth(address destAddr) external payable returns (uint256) {
        lastDestAddr = destAddr;
        lastValue = msg.value;
        messageNum++;

        emit InboxMessageDelivered(messageNum, abi.encode(destAddr, msg.value));

        return messageNum;
    }
}

contract ArbL1ToL2NativeBridgeTest is Test {
    using TypeCasts for address;

    ArbL1ToL2NativeBridge internal bridge;
    MockInbox internal mockInbox;

    address internal constant RECIPIENT = address(0xBEEF);

    uint32 internal constant DESTINATION_DOMAIN = 42161; // Arbitrum One

    function setUp() public {
        mockInbox = new MockInbox();
        bridge = new ArbL1ToL2NativeBridge(address(mockInbox));
    }

    // ============ Constructor Tests ============

    function test_constructor() public view {
        assertEq(address(bridge.inbox()), address(mockInbox));
    }

    function test_constructor_revertsIfInboxNotContract() public {
        vm.expectRevert("Inbox must be a contract");
        new ArbL1ToL2NativeBridge(address(0x1234));
    }

    // ============ Quote Tests ============

    function test_quoteTransferRemote_returnsAmount() public view {
        uint256 amount = 1 ether;
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, address(0)); // Native ETH
        assertEq(quotes[0].amount, amount); // Returns the amount itself (no extra fees)
    }

    function testFuzz_quoteTransferRemote(uint256 amount) public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, amount);
    }

    // ============ Transfer Tests ============

    function test_transferRemote() public {
        uint256 amount = 1 ether;
        vm.deal(address(this), amount);

        bytes32 transferId = bridge.transferRemote{value: amount}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        // Verify the mock inbox received the correct call
        assertEq(mockInbox.lastDestAddr(), RECIPIENT);
        assertEq(mockInbox.lastValue(), amount);

        // Transfer ID is zero (native bridge doesn't provide meaningful ID)
        assertEq(transferId, bytes32(0));

        // Verify ETH was sent to the inbox
        assertEq(address(mockInbox).balance, amount);
    }

    function testFuzz_transferRemote(uint256 amount, address recipient) public {
        vm.assume(amount > 0);
        vm.assume(recipient != address(0));

        vm.deal(address(this), amount);

        bridge.transferRemote{value: amount}(
            DESTINATION_DOMAIN,
            recipient.addressToBytes32(),
            amount
        );

        assertEq(mockInbox.lastDestAddr(), recipient);
        assertEq(mockInbox.lastValue(), amount);
        assertEq(address(mockInbox).balance, amount);
    }

    function test_transferRemote_revertsIfAmountZero() public {
        vm.expectRevert("Amount must be greater than 0");
        bridge.transferRemote{value: 0}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            0
        );
    }

    function test_transferRemote_revertsIfInsufficientValue() public {
        uint256 amount = 1 ether;
        vm.deal(address(this), amount - 1);

        vm.expectRevert("Insufficient native token");
        bridge.transferRemote{value: amount - 1}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );
    }

    function test_transferRemote_acceptsExcessValue() public {
        uint256 amount = 1 ether;
        uint256 excess = 0.5 ether;
        vm.deal(address(this), amount + excess);

        // Should not revert - only sends `amount` to the inbox
        bridge.transferRemote{value: amount + excess}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        // Inbox only receives the amount, not the excess
        assertEq(mockInbox.lastValue(), amount);
        assertEq(address(mockInbox).balance, amount);
    }

    function test_transferRemote_emitsEvent() public {
        uint256 amount = 1 ether;
        vm.deal(address(this), amount);

        vm.expectEmit(true, true, false, true);
        emit ArbL1ToL2NativeBridge.SentTransferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        bridge.transferRemote{value: amount}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );
    }

    // ============ Integration Test with HypNative Pattern ============

    function test_integration_rebalancePattern() public {
        // Simulate HypNative rebalance pattern
        address hypNative = address(0xCAFE);
        uint256 rebalanceAmount = 10 ether;

        // HypNative has ETH collateral
        vm.deal(hypNative, rebalanceAmount);

        // HypNative calls transferRemote (simulating rebalance)
        vm.prank(hypNative);
        bridge.transferRemote{value: rebalanceAmount}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            rebalanceAmount
        );

        // Verify ETH moved to inbox
        assertEq(hypNative.balance, 0);
        assertEq(address(mockInbox).balance, rebalanceAmount);
        assertEq(mockInbox.lastDestAddr(), RECIPIENT);
    }

    // ============ Comparison with ERC20 Bridge ============

    function test_noFeeRequired() public view {
        // Unlike ArbL1ToL2ERC20Bridge, the native bridge requires no fees
        // The quote should just be the amount being transferred
        uint256 amount = 1 ether;

        Quote[] memory quotes = bridge.quoteTransferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        // Only the amount is required, no additional fee
        assertEq(quotes[0].amount, amount);
    }

    // Allow receiving ETH (for any refunds)
    receive() external payable {}
}
