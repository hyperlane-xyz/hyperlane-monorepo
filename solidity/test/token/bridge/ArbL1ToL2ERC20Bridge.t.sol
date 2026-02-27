// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {ArbL1ToL2ERC20Bridge} from "contracts/token/bridge/ArbL1ToL2ERC20Bridge.sol";
import {IL1GatewayRouter} from "contracts/interfaces/arbitrum/IL1GatewayRouter.sol";
import {Quote} from "contracts/interfaces/ITokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import {ERC20Test} from "../../../contracts/test/ERC20Test.sol";

contract MockGateway {
    event DepositInitiated(
        address l1Token,
        address indexed from,
        address indexed to,
        uint256 indexed sequenceNumber,
        uint256 amount
    );

    address public lastToken;
    address public lastFrom;
    address public lastTo;
    uint256 public lastAmount;

    function finalizeInboundTransfer(
        address _token,
        address _from,
        address _to,
        uint256 _amount,
        bytes calldata
    ) external {
        lastToken = _token;
        lastFrom = _from;
        lastTo = _to;
        lastAmount = _amount;

        // Pull tokens from the caller (the bridge adapter)
        ERC20Test(_token).transferFrom(_from, address(this), _amount);

        emit DepositInitiated(_token, _from, _to, 0, _amount);
    }
}

contract MockL1GatewayRouter {
    event DepositInitiated(
        address l1Token,
        address indexed from,
        address indexed to,
        uint256 indexed sequenceNumber,
        uint256 amount
    );

    MockGateway public gatewayContract;
    address public lastToken;
    address public lastRefundTo;
    address public lastTo;
    uint256 public lastAmount;
    uint256 public lastMaxGas;
    uint256 public lastGasPriceBid;
    bytes public lastData;
    uint256 public lastValue;

    constructor(MockGateway _gateway) {
        gatewayContract = _gateway;
    }

    function getGateway(address) external view returns (address) {
        return address(gatewayContract);
    }

    function calculateL2TokenAddress(
        address _token
    ) external pure returns (address) {
        // Return a deterministic L2 address based on L1 token
        return address(uint160(uint256(keccak256(abi.encode(_token)))));
    }

    function outboundTransferCustomRefund(
        address _token,
        address _refundTo,
        address _to,
        uint256 _amount,
        uint256 _maxGas,
        uint256 _gasPriceBid,
        bytes calldata _data
    ) external payable returns (bytes memory) {
        lastToken = _token;
        lastRefundTo = _refundTo;
        lastTo = _to;
        lastAmount = _amount;
        lastMaxGas = _maxGas;
        lastGasPriceBid = _gasPriceBid;
        lastData = _data;
        lastValue = msg.value;

        // In real Arbitrum, the router delegates to the gateway which pulls tokens
        // Here we simulate by calling the gateway's finalizeInboundTransfer
        gatewayContract.finalizeInboundTransfer(
            _token,
            msg.sender,
            _to,
            _amount,
            ""
        );

        emit DepositInitiated(_token, msg.sender, _to, 0, _amount);

        return abi.encode(uint256(0)); // sequence number
    }
}

contract ArbL1ToL2ERC20BridgeTest is Test {
    using TypeCasts for address;

    ArbL1ToL2ERC20Bridge internal bridge;
    MockL1GatewayRouter internal mockRouter;
    MockGateway internal mockGateway;
    ERC20Test internal token;

    address internal constant RECIPIENT = address(0xBEEF);

    uint32 internal constant DESTINATION_DOMAIN = 42161; // Arbitrum One

    // Default fee parameters for tests
    uint256 internal constant MAX_SUBMISSION_COST = 0.01 ether;
    uint256 internal constant MAX_GAS = 200_000;
    uint256 internal constant GAS_PRICE_BID = 0.5 gwei;

    function setUp() public {
        token = new ERC20Test("Test Token", "TEST", 0, 18);
        mockGateway = new MockGateway();
        mockRouter = new MockL1GatewayRouter(mockGateway);

        bridge = new ArbL1ToL2ERC20Bridge(
            address(mockRouter),
            address(token),
            MAX_SUBMISSION_COST,
            MAX_GAS,
            GAS_PRICE_BID
        );

        // The constructor already approves the gateway, but we need to ensure it's set
        // In case getGateway returned address(0) during construction
        vm.prank(address(bridge));
        token.approve(address(mockGateway), type(uint256).max);
    }

    // ============ Constructor Tests ============

    function test_constructor() public view {
        assertEq(address(bridge.l1GatewayRouter()), address(mockRouter));
        assertEq(bridge.localToken(), address(token));
        assertEq(bridge.maxSubmissionCost(), MAX_SUBMISSION_COST);
        assertEq(bridge.maxGas(), MAX_GAS);
        assertEq(bridge.gasPriceBid(), GAS_PRICE_BID);
    }

    function test_constructor_revertsIfRouterNotContract() public {
        vm.expectRevert("Gateway router must be a contract");
        new ArbL1ToL2ERC20Bridge(
            address(0x1234), // EOA
            address(token),
            MAX_SUBMISSION_COST,
            MAX_GAS,
            GAS_PRICE_BID
        );
    }

    function test_constructor_revertsIfLocalTokenNotContract() public {
        vm.expectRevert("Local token must be a contract");
        new ArbL1ToL2ERC20Bridge(
            address(mockRouter),
            address(0x1234), // EOA
            MAX_SUBMISSION_COST,
            MAX_GAS,
            GAS_PRICE_BID
        );
    }

    function test_constructor_customFeeParams() public {
        uint256 customSubmissionCost = 0.02 ether;
        uint256 customMaxGas = 500_000;
        uint256 customGasPriceBid = 1 gwei;

        ArbL1ToL2ERC20Bridge customBridge = new ArbL1ToL2ERC20Bridge(
            address(mockRouter),
            address(token),
            customSubmissionCost,
            customMaxGas,
            customGasPriceBid
        );

        assertEq(customBridge.maxSubmissionCost(), customSubmissionCost);
        assertEq(customBridge.maxGas(), customMaxGas);
        assertEq(customBridge.gasPriceBid(), customGasPriceBid);
    }

    // ============ Quote Tests ============

    function test_quoteTransferRemote_returnsNativeFee() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            1e18
        );

        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, address(0)); // Native ETH

        uint256 expectedFee = MAX_SUBMISSION_COST + MAX_GAS * GAS_PRICE_BID;
        assertEq(quotes[0].amount, expectedFee);
    }

    function test_quoteTransferRemote_withCustomFeeParams() public {
        uint256 customSubmissionCost = 0.02 ether;
        uint256 customMaxGas = 500_000;
        uint256 customGasPriceBid = 1 gwei;

        ArbL1ToL2ERC20Bridge customBridge = new ArbL1ToL2ERC20Bridge(
            address(mockRouter),
            address(token),
            customSubmissionCost,
            customMaxGas,
            customGasPriceBid
        );

        Quote[] memory quotes = customBridge.quoteTransferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            1e18
        );

        uint256 expectedFee = customSubmissionCost +
            customMaxGas *
            customGasPriceBid;
        assertEq(quotes[0].amount, expectedFee);
    }

    // ============ Transfer Tests ============

    function test_transferRemote() public {
        uint256 amount = 1e18;
        uint256 fee = bridge.maxSubmissionCost() +
            bridge.maxGas() *
            bridge.gasPriceBid();

        // Mint tokens to the test contract and approve the bridge
        token.mintTo(address(this), amount);
        token.approve(address(bridge), amount);

        // Execute transfer with ETH fee
        bytes32 transferId = bridge.transferRemote{value: fee}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        // Verify the mock router received the correct call
        assertEq(mockRouter.lastToken(), address(token));
        assertEq(mockRouter.lastRefundTo(), RECIPIENT);
        assertEq(mockRouter.lastTo(), RECIPIENT);
        assertEq(mockRouter.lastAmount(), amount);
        assertEq(mockRouter.lastMaxGas(), bridge.maxGas());
        assertEq(mockRouter.lastGasPriceBid(), bridge.gasPriceBid());
        assertEq(mockRouter.lastValue(), fee);

        // Verify data encoding
        (uint256 decodedMaxSubmissionCost, bytes memory callHookData) = abi
            .decode(mockRouter.lastData(), (uint256, bytes));
        assertEq(decodedMaxSubmissionCost, bridge.maxSubmissionCost());
        assertEq(callHookData, "");

        // Verify tokens were transferred to the gateway (via router)
        assertEq(token.balanceOf(address(this)), 0);
        assertEq(token.balanceOf(address(mockGateway)), amount);

        // Transfer ID is zero (native bridge doesn't provide one)
        assertEq(transferId, bytes32(0));
    }

    function testFuzz_transferRemote(uint256 amount, address recipient) public {
        vm.assume(amount > 0);
        vm.assume(recipient != address(0));

        uint256 fee = bridge.maxSubmissionCost() +
            bridge.maxGas() *
            bridge.gasPriceBid();

        // Mint tokens to the test contract and approve the bridge
        token.mintTo(address(this), amount);
        token.approve(address(bridge), amount);

        vm.deal(address(this), fee);

        // Execute transfer
        bridge.transferRemote{value: fee}(
            DESTINATION_DOMAIN,
            recipient.addressToBytes32(),
            amount
        );

        // Verify the mock router received the correct call
        assertEq(mockRouter.lastTo(), recipient);
        assertEq(mockRouter.lastAmount(), amount);

        // Verify tokens were transferred to gateway
        assertEq(token.balanceOf(address(mockGateway)), amount);
    }

    function test_transferRemote_revertsIfAmountZero() public {
        uint256 fee = bridge.maxSubmissionCost() +
            bridge.maxGas() *
            bridge.gasPriceBid();

        vm.expectRevert("Amount must be greater than 0");
        bridge.transferRemote{value: fee}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            0
        );
    }

    function test_transferRemote_revertsIfInsufficientFee() public {
        uint256 amount = 1e18;
        uint256 fee = bridge.maxSubmissionCost() +
            bridge.maxGas() *
            bridge.gasPriceBid();

        token.mintTo(address(this), amount);
        token.approve(address(bridge), amount);

        vm.expectRevert("Insufficient native fee");
        bridge.transferRemote{value: fee - 1}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );
    }

    function test_transferRemote_acceptsExcessFee() public {
        uint256 amount = 1e18;
        uint256 fee = bridge.maxSubmissionCost() +
            bridge.maxGas() *
            bridge.gasPriceBid();
        uint256 excessFee = fee * 2;

        token.mintTo(address(this), amount);
        token.approve(address(bridge), amount);
        vm.deal(address(this), excessFee);

        // Should not revert - excess goes to recipient on L2
        bridge.transferRemote{value: excessFee}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            amount
        );

        assertEq(mockRouter.lastValue(), excessFee);
    }

    // ============ Constructor Gateway Tests ============

    function test_constructor_revertsIfNoGateway() public {
        // Deploy a router that returns zero gateway
        MockL1GatewayRouter routerNoGateway = new MockL1GatewayRouter(
            MockGateway(address(0))
        );

        vm.expectRevert("No gateway for token");
        new ArbL1ToL2ERC20Bridge(
            address(routerNoGateway),
            address(token),
            MAX_SUBMISSION_COST,
            MAX_GAS,
            GAS_PRICE_BID
        );
    }

    function test_constructor_approvesGateway() public view {
        // Verify the constructor approved the gateway
        assertEq(
            token.allowance(address(bridge), address(mockGateway)),
            type(uint256).max
        );
    }

    // ============ Integration Test with HypERC20Collateral Pattern ============

    function test_integration_rebalancePattern() public {
        // Simulate HypERC20Collateral rebalance pattern
        address collateralRouter = address(0xC011A7E4A1);
        uint256 rebalanceAmount = 100e18;
        uint256 fee = bridge.maxSubmissionCost() +
            bridge.maxGas() *
            bridge.gasPriceBid();

        // Router has tokens
        token.mintTo(collateralRouter, rebalanceAmount);

        // Router approves the bridge
        vm.prank(collateralRouter);
        token.approve(address(bridge), rebalanceAmount);

        // Router gets ETH for fees
        vm.deal(collateralRouter, fee);

        // Router calls transferRemote (simulating rebalance)
        vm.prank(collateralRouter);
        bridge.transferRemote{value: fee}(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            rebalanceAmount
        );

        // Verify tokens moved to gateway (will be locked for L2 minting)
        assertEq(token.balanceOf(collateralRouter), 0);
        assertEq(token.balanceOf(address(mockGateway)), rebalanceAmount);
    }

    // ============ Fee Calculation Tests ============

    function testFuzz_feeCalculation(
        uint256 _maxSubmissionCost,
        uint256 _maxGas,
        uint256 _gasPriceBid
    ) public {
        // Bound to reasonable values to avoid overflow
        _maxSubmissionCost = bound(_maxSubmissionCost, 0, 1 ether);
        _maxGas = bound(_maxGas, 1, 10_000_000);
        _gasPriceBid = bound(_gasPriceBid, 0, 1000 gwei);

        ArbL1ToL2ERC20Bridge fuzzBridge = new ArbL1ToL2ERC20Bridge(
            address(mockRouter),
            address(token),
            _maxSubmissionCost,
            _maxGas,
            _gasPriceBid
        );

        Quote[] memory quotes = fuzzBridge.quoteTransferRemote(
            DESTINATION_DOMAIN,
            RECIPIENT.addressToBytes32(),
            1e18
        );

        uint256 expectedFee = _maxSubmissionCost + _maxGas * _gasPriceBid;
        assertEq(quotes[0].amount, expectedFee);
    }

    // Allow receiving ETH (for any refunds)
    receive() external payable {}
}
