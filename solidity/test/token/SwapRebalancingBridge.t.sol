// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {TestSwapTarget} from "contracts/test/TestSwapTarget.sol";
import {SwapRebalancingBridge} from "contracts/token/SwapRebalancingBridge.sol";
import {ISwapRebalancingBridge, SwapCall} from "contracts/token/interfaces/ISwapRebalancingBridge.sol";
import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";

contract MockRebalanceRouter {
    ERC20Test public immutable wrappedToken;
    uint32 public immutable localDomain;
    uint256 public immutable scaleNumerator;
    uint256 public immutable scaleDenominator;

    mapping(uint32 => bytes32) public routers;
    mapping(uint32 => mapping(bytes32 => bool)) public crossCollateralRouters;

    bytes32 public callbackRecipient;
    bool public quoteOnly;

    constructor(
        ERC20Test _token,
        uint32 _localDomain,
        uint256 _scaleNumerator,
        uint256 _scaleDenominator
    ) {
        wrappedToken = _token;
        localDomain = _localDomain;
        scaleNumerator = _scaleNumerator;
        scaleDenominator = _scaleDenominator;
    }

    function token() external view returns (address) {
        return address(wrappedToken);
    }

    function setPrimaryRouter(uint32 domain, address router) external {
        routers[domain] = _toBytes32(router);
    }

    function setCrossRouter(
        uint32 domain,
        address router,
        bool enrolled
    ) external {
        crossCollateralRouters[domain][_toBytes32(router)] = enrolled;
    }

    function setCallbackRecipient(address recipient) external {
        callbackRecipient = _toBytes32(recipient);
    }

    function setQuoteOnly(bool _quoteOnly) external {
        quoteOnly = _quoteOnly;
    }

    function rebalance(
        uint32 domain,
        uint256 collateralAmount,
        ITokenBridge bridge
    ) external payable {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            domain,
            callbackRecipient,
            collateralAmount
        );
        if (quoteOnly) return;
        wrappedToken.approve(address(bridge), quotes[1].amount);
        bridge.transferRemote(domain, callbackRecipient, collateralAmount);
    }

    function _toBytes32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}

contract SwapRebalancingBridgeTest is Test {
    uint32 internal constant LOCAL_DOMAIN = 10;

    SwapRebalancingBridge internal bridge;
    ERC20Test internal inputToken;
    ERC20Test internal outputToken;
    MockRebalanceRouter internal sourceRouter;
    MockRebalanceRouter internal destinationRouter;
    MockRebalanceRouter internal altDestinationRouter;
    TestSwapTarget internal swapTarget;

    address internal rebalancer = makeAddr("rebalancer");
    address internal other = makeAddr("other");

    function setUp() public {
        bridge = new SwapRebalancingBridge();
        inputToken = new ERC20Test("Input", "IN", 0, 6);
        outputToken = new ERC20Test("Output", "OUT", 0, 18);

        sourceRouter = new MockRebalanceRouter(
            inputToken,
            LOCAL_DOMAIN,
            1e12,
            1
        );
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        altDestinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));
        sourceRouter.setCrossRouter(
            LOCAL_DOMAIN,
            address(altDestinationRouter),
            true
        );
        sourceRouter.setCallbackRecipient(other);

        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        bridge.setAuthorizedRebalancer(rebalancer, true);
        bridge.setTarget(address(swapTarget), true);
        bridge.setAllowanceTarget(address(swapTarget), true);

        inputToken.mintTo(address(sourceRouter), 1_000_000e6);
        outputToken.mintTo(address(swapTarget), type(uint128).max);
    }

    function test_executeRebalance_revertsUnauthorized() public {
        vm.expectRevert(SwapRebalancingBridge.UnauthorizedRebalancer.selector);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            100e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );
    }

    function test_executeRebalance_revertsWhenDestinationNotEnrolled() public {
        MockRebalanceRouter unlisted = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        vm.prank(rebalancer);
        vm.expectRevert(SwapRebalancingBridge.DestinationNotEnrolled.selector);
        bridge.executeRebalance(
            address(sourceRouter),
            address(unlisted),
            100e6,
            100e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );
    }

    function test_executeRebalance_revertsWhenDomainMismatch() public {
        MockRebalanceRouter remote = new MockRebalanceRouter(
            outputToken,
            99,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(remote));
        vm.prank(rebalancer);
        vm.expectRevert(SwapRebalancingBridge.InvalidDomain.selector);
        bridge.executeRebalance(
            address(sourceRouter),
            address(remote),
            100e6,
            100e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );
    }

    function test_executeRebalance_revertsWhenDeadlineExpired() public {
        vm.prank(rebalancer);
        vm.expectRevert(SwapRebalancingBridge.DeadlineExpired.selector);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            100e18,
            block.timestamp - 1,
            _swapCalls(100e6)
        );
    }

    function test_quoteTransferRemote_returnsSourceTokenQuote() public {
        sourceRouter.setQuoteOnly(true);
        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            100e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );

        Quote[] memory quotes = bridge.quoteTransferRemote(
            LOCAL_DOMAIN,
            bytes32(0),
            100e6
        );
        assertEq(quotes.length, 3);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0);
        assertEq(quotes[1].token, address(inputToken));
        assertEq(quotes[1].amount, 100e6);
        assertEq(quotes[2].amount, 0);
    }

    function test_transferRemote_ignoresRecipientAndPaysExactNominal() public {
        swapTarget.setOutputAmount(100e18);

        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            99e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e18);
        assertEq(outputToken.balanceOf(rebalancer), 0);
    }

    function test_transferRemote_pullsShortfallFromRebalancer() public {
        swapTarget.setOutputAmount(97e18);
        outputToken.mintTo(rebalancer, 10e18);
        vm.prank(rebalancer);
        outputToken.approve(address(bridge), type(uint256).max);

        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e18);
        assertEq(outputToken.balanceOf(rebalancer), 7e18);
    }

    function test_transferRemote_refundsSurplusToRebalancer() public {
        swapTarget.setOutputAmount(103e18);

        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e18);
        assertEq(outputToken.balanceOf(rebalancer), 3e18);
    }

    function test_transferRemote_revertsWhenAmountOutBelowMin() public {
        swapTarget.setOutputAmount(89e18);
        outputToken.mintTo(rebalancer, 100e18);
        vm.prank(rebalancer);
        outputToken.approve(address(bridge), type(uint256).max);

        vm.prank(rebalancer);
        vm.expectRevert(SwapRebalancingBridge.AmountOutTooLow.selector);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );
    }

    function test_transferRemote_revertsOnUnapprovedTarget() public {
        bridge.setTarget(address(swapTarget), false);

        vm.prank(rebalancer);
        vm.expectRevert(SwapRebalancingBridge.UnapprovedTarget.selector);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );
    }

    function test_transferRemote_revertsOnUnapprovedAllowanceTarget() public {
        bridge.setAllowanceTarget(address(swapTarget), false);

        vm.prank(rebalancer);
        vm.expectRevert(
            SwapRebalancingBridge.UnapprovedAllowanceTarget.selector
        );
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );
    }

    function test_transferRemote_revertsIfInputNotFullySpent() public {
        outputToken.mintTo(rebalancer, 100e18);
        vm.prank(rebalancer);
        outputToken.approve(address(bridge), type(uint256).max);

        SwapCall[] memory noSwapCalls = new SwapCall[](0);

        vm.prank(rebalancer);
        vm.expectRevert(SwapRebalancingBridge.InputNotFullySpent.selector);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            0,
            block.timestamp + 1,
            noSwapCalls
        );
    }

    function test_transferRemote_clearsApprovalAfterSwap() public {
        swapTarget.setOutputAmount(100e18);

        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );

        assertEq(inputToken.allowance(address(bridge), address(swapTarget)), 0);
        assertEq(
            outputToken.allowance(address(bridge), address(swapTarget)),
            0
        );
    }

    function test_executeRebalance_usesCrossCollateralEnrollmentPath() public {
        swapTarget.setOutputAmount(100e18);

        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(altDestinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );

        assertEq(outputToken.balanceOf(address(altDestinationRouter)), 100e18);
    }

    function test_revertsOnConcurrentPendingRebalance() public {
        sourceRouter.setQuoteOnly(true);
        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );

        vm.prank(rebalancer);
        vm.expectRevert(SwapRebalancingBridge.RebalanceAlreadyPending.selector);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            100e6,
            90e18,
            block.timestamp + 1,
            _swapCalls(100e6)
        );
    }

    function _swapCalls(
        uint256 amountIn
    ) internal view returns (SwapCall[] memory calls) {
        calls = new SwapCall[](1);
        calls[0] = SwapCall({
            target: address(swapTarget),
            allowanceTarget: address(swapTarget),
            data: abi.encodeWithSelector(
                TestSwapTarget.swapExactInput.selector,
                amountIn
            )
        });
    }
}
