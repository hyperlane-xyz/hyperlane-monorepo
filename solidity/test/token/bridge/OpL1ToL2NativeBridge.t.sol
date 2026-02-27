// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {OpL1ToL2NativeBridge} from "contracts/token/bridge/OpL1ToL2NativeBridge.sol";
import {IStandardBridge} from "contracts/interfaces/optimism/IStandardBridge.sol";
import {Quote} from "contracts/interfaces/ITokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

contract MockL1StandardBridgeNative {
    event ETHBridgeInitiated(
        address indexed from,
        address indexed to,
        uint256 amount,
        bytes extraData
    );

    address public lastTo;
    uint32 public lastMinGasLimit;
    bytes public lastExtraData;
    uint256 public lastValue;

    function bridgeETHTo(
        address _to,
        uint32 _minGasLimit,
        bytes calldata _extraData
    ) external payable {
        lastTo = _to;
        lastMinGasLimit = _minGasLimit;
        lastExtraData = _extraData;
        lastValue = msg.value;

        emit ETHBridgeInitiated(msg.sender, _to, msg.value, _extraData);
    }
}

contract OpL1ToL2NativeBridgeTest is Test {
    using TypeCasts for address;

    OpL1ToL2NativeBridge internal bridge;
    MockL1StandardBridgeNative internal mockBridge;

    address internal constant RECIPIENT = address(0xBEEF);

    uint32 internal constant DESTINATION_DOMAIN = 10; // Optimism

    function setUp() public {
        mockBridge = new MockL1StandardBridgeNative();
        bridge = new OpL1ToL2NativeBridge(address(mockBridge));
    }

    // ============ Constructor Tests ============

    function test_constructor() public view {
        assertEq(address(bridge.l1Bridge()), address(mockBridge));
        assertEq(bridge.MIN_GAS_LIMIT(), 100_000);
    }

    function test_constructor_revertsIfL1BridgeNotContract() public {
        vm.expectRevert("L1 bridge must be a contract");
        new OpL1ToL2NativeBridge(address(0x1234));
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
        assertEq(quotes[0].amount, amount); // Returns the amount itself
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

        // Verify the mock bridge received the correct call
        assertEq(mockBridge.lastTo(), RECIPIENT);
        assertEq(mockBridge.lastMinGasLimit(), bridge.MIN_GAS_LIMIT());
        assertEq(mockBridge.lastExtraData(), "");
        assertEq(mockBridge.lastValue(), amount);

        // Transfer ID is zero (native bridge doesn't provide one)
        assertEq(transferId, bytes32(0));

        // Verify ETH was sent to the bridge
        assertEq(address(mockBridge).balance, amount);
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

        assertEq(mockBridge.lastTo(), recipient);
        assertEq(mockBridge.lastValue(), amount);
        assertEq(address(mockBridge).balance, amount);
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

        // Should not revert - only sends `amount` to the bridge
        bridge.transferRemote{value: amount + excess}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        // Bridge only receives the amount, not the excess
        assertEq(mockBridge.lastValue(), amount);
        assertEq(address(mockBridge).balance, amount);
    }

    function test_transferRemote_emitsEvent() public {
        uint256 amount = 1 ether;
        vm.deal(address(this), amount);

        vm.expectEmit(true, true, false, true);
        emit OpL1ToL2NativeBridge.SentTransferRemote(
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

        // Verify ETH moved to bridge
        assertEq(hypNative.balance, 0);
        assertEq(address(mockBridge).balance, rebalanceAmount);
        assertEq(mockBridge.lastTo(), RECIPIENT);
    }

    // Allow receiving ETH (for any refunds)
    receive() external payable {}
}
