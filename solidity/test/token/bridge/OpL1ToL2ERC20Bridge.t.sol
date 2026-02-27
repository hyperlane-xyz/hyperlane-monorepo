// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {OpL1ToL2ERC20Bridge} from "contracts/token/bridge/OpL1ToL2ERC20Bridge.sol";
import {IStandardBridge} from "contracts/interfaces/optimism/IStandardBridge.sol";
import {Quote} from "contracts/interfaces/ITokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import {ERC20Test} from "../../../contracts/test/ERC20Test.sol";

contract MockL1StandardBridge {
    event ERC20BridgeInitiated(
        address indexed localToken,
        address indexed remoteToken,
        address indexed from,
        address to,
        uint256 amount,
        bytes extraData
    );

    address public lastLocalToken;
    address public lastRemoteToken;
    address public lastTo;
    uint256 public lastAmount;
    uint32 public lastMinGasLimit;
    bytes public lastExtraData;

    function bridgeERC20To(
        address _localToken,
        address _remoteToken,
        address _to,
        uint256 _amount,
        uint32 _minGasLimit,
        bytes memory _extraData
    ) external {
        lastLocalToken = _localToken;
        lastRemoteToken = _remoteToken;
        lastTo = _to;
        lastAmount = _amount;
        lastMinGasLimit = _minGasLimit;
        lastExtraData = _extraData;

        // Transfer tokens from caller (the bridge adapter) to this contract
        ERC20Test(_localToken).transferFrom(msg.sender, address(this), _amount);

        emit ERC20BridgeInitiated(
            _localToken,
            _remoteToken,
            msg.sender,
            _to,
            _amount,
            _extraData
        );
    }
}

contract OpL1ToL2ERC20BridgeTest is Test {
    using TypeCasts for address;

    OpL1ToL2ERC20Bridge internal bridge;
    MockL1StandardBridge internal mockL1Bridge;
    ERC20Test internal token;

    address internal constant REMOTE_TOKEN = address(0xDEAD);
    address internal constant RECIPIENT = address(0xBEEF);

    uint32 internal constant DESTINATION_DOMAIN = 10; // Optimism

    function setUp() public {
        token = new ERC20Test("Test Token", "TEST", 0, 18);
        mockL1Bridge = new MockL1StandardBridge();

        bridge = new OpL1ToL2ERC20Bridge(
            address(mockL1Bridge),
            address(token),
            REMOTE_TOKEN
        );
    }

    // ============ Constructor Tests ============

    function test_constructor() public view {
        assertEq(address(bridge.l1Bridge()), address(mockL1Bridge));
        assertEq(bridge.localToken(), address(token));
        assertEq(bridge.remoteToken(), REMOTE_TOKEN);

        // Check that the bridge has max approval for the L1 bridge
        assertEq(
            token.allowance(address(bridge), address(mockL1Bridge)),
            type(uint256).max
        );
    }

    function test_constructor_revertsIfL1BridgeNotContract() public {
        vm.expectRevert("L1 bridge must be a contract");
        new OpL1ToL2ERC20Bridge(
            address(0x1234), // EOA
            address(token),
            REMOTE_TOKEN
        );
    }

    function test_constructor_revertsIfLocalTokenNotContract() public {
        vm.expectRevert("Local token must be a contract");
        new OpL1ToL2ERC20Bridge(
            address(mockL1Bridge),
            address(0x1234), // EOA
            REMOTE_TOKEN
        );
    }

    // ============ Quote Tests ============

    function test_quoteTransferRemote_returnsEmptyQuotes() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            1e18
        );

        assertEq(quotes.length, 0);
    }

    // ============ Transfer Tests ============

    function test_transferRemote() public {
        uint256 amount = 1e18;

        // Mint tokens to the test contract and approve the bridge
        token.mintTo(address(this), amount);
        token.approve(address(bridge), amount);

        // Execute transfer
        bytes32 transferId = bridge.transferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        // Verify the mock bridge received the correct call
        assertEq(mockL1Bridge.lastLocalToken(), address(token));
        assertEq(mockL1Bridge.lastRemoteToken(), REMOTE_TOKEN);
        assertEq(mockL1Bridge.lastTo(), RECIPIENT);
        assertEq(mockL1Bridge.lastAmount(), amount);
        assertEq(mockL1Bridge.lastMinGasLimit(), bridge.MIN_GAS_LIMIT());
        assertEq(mockL1Bridge.lastExtraData(), "");

        // Verify tokens were transferred
        assertEq(token.balanceOf(address(this)), 0);
        assertEq(token.balanceOf(address(mockL1Bridge)), amount);

        // Transfer ID is zero (native bridge doesn't provide one)
        assertEq(transferId, bytes32(0));
    }

    function testFuzz_transferRemote(uint256 amount, address recipient) public {
        vm.assume(amount > 0);
        vm.assume(recipient != address(0));

        // Mint tokens to the test contract and approve the bridge
        token.mintTo(address(this), amount);
        token.approve(address(bridge), amount);

        // Execute transfer
        bridge.transferRemote(
            DESTINATION_DOMAIN,
            recipient.addressToBytes32(),
            amount
        );

        // Verify the mock bridge received the correct call
        assertEq(mockL1Bridge.lastTo(), recipient);
        assertEq(mockL1Bridge.lastAmount(), amount);

        // Verify tokens were transferred
        assertEq(token.balanceOf(address(mockL1Bridge)), amount);
    }

    function test_constructor_revertsIfRemoteTokenZero() public {
        vm.expectRevert("Remote token cannot be zero");
        new OpL1ToL2ERC20Bridge(
            address(mockL1Bridge),
            address(token),
            address(0) // No remote token
        );
    }

    function test_transferRemote_revertsIfAmountZero() public {
        vm.expectRevert("Amount must be greater than 0");
        bridge.transferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            0
        );
    }

    // ============ Admin Tests ============

    // ============ Integration Test with HypERC20Collateral Pattern ============

    function test_integration_rebalancePattern() public {
        // Simulate HypERC20Collateral rebalance pattern
        address collateralRouter = address(0xC011A7E4A1);
        uint256 rebalanceAmount = 100e18;

        // Router has tokens
        token.mintTo(collateralRouter, rebalanceAmount);

        // Router approves the bridge
        vm.prank(collateralRouter);
        token.approve(address(bridge), rebalanceAmount);

        // Router calls transferRemote (simulating rebalance)
        vm.prank(collateralRouter);
        bridge.transferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            rebalanceAmount
        );

        // Verify tokens moved to L1 bridge (will be locked and minted on L2)
        assertEq(token.balanceOf(collateralRouter), 0);
        assertEq(token.balanceOf(address(mockL1Bridge)), rebalanceAmount);
    }
}
