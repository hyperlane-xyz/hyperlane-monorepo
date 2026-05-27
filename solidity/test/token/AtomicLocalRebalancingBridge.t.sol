// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {TestSwapTarget} from "contracts/test/TestSwapTarget.sol";
import {CallLib} from "contracts/middleware/libs/Call.sol";
import {AtomicLocalRebalancingBridge, CallInvariant} from "contracts/token/AtomicLocalRebalancingBridge.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {Quotes} from "contracts/token/libs/Quotes.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockRebalanceRouter {
    using Quotes for Quote[];

    ERC20Test public immutable wrappedToken;
    uint32 public immutable localDomain;
    uint256 public immutable scaleNumerator;
    uint256 public immutable scaleDenominator;

    mapping(uint32 => bytes32) public routers;
    mapping(uint32 => bytes32) public allowedRecipient;
    mapping(uint32 => mapping(bytes32 => bool)) public crossCollateralRouters;
    address[] internal _allowedRebalancers;
    mapping(address => bool) public isAllowedRebalancer;

    bytes32 public callbackRecipient;
    uint32 public callbackDomain;
    address public callbackSender;
    bool public quoteOnly;
    bool public reenter;

    constructor(
        ERC20Test _token,
        uint32 _localDomain,
        uint256 _scaleNumerator,
        uint256 _scaleDenominator
    ) {
        wrappedToken = _token;
        localDomain = _localDomain;
        callbackDomain = _localDomain;
        scaleNumerator = _scaleNumerator;
        scaleDenominator = _scaleDenominator;
    }

    function token() external view returns (address) {
        return address(wrappedToken);
    }

    function setPrimaryRouter(uint32 domain, address router) external {
        routers[domain] = _toBytes32(router);
    }

    function setRecipient(uint32 domain, address recipient) external {
        allowedRecipient[domain] = _toBytes32(recipient);
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

    function setCallbackDomain(uint32 domain) external {
        callbackDomain = domain;
    }

    function setCallbackSender(address sender) external {
        callbackSender = sender;
    }

    function setQuoteOnly(bool _quoteOnly) external {
        quoteOnly = _quoteOnly;
    }

    function setReenter(bool _reenter) external {
        reenter = _reenter;
    }

    function approveTokenForBridge(ITokenBridge bridge) external {
        wrappedToken.approve(address(bridge), type(uint256).max);
    }

    function addRebalancer(address rebalancer) external {
        if (!isAllowedRebalancer[rebalancer]) {
            _allowedRebalancers.push(rebalancer);
            isAllowedRebalancer[rebalancer] = true;
        }
    }

    function allowedRebalancers() external view returns (address[] memory) {
        return _allowedRebalancers;
    }

    function rebalance(
        uint32 domain,
        uint256 collateralAmount,
        ITokenBridge bridge
    ) external payable {
        require(isAllowedRebalancer[msg.sender], "MCR: Only Rebalancer");
        Quote[] memory quotes = bridge.quoteTransferRemote(
            domain,
            callbackRecipient,
            collateralAmount
        );
        if (reenter) {
            CallLib.Call[] memory calls = new CallLib.Call[](0);
            AtomicLocalRebalancingBridge(address(bridge)).localRebalance(
                address(this),
                collateralAmount,
                calls
            );
        }
        if (quoteOnly) return;
        require(
            quotes.extract(address(wrappedToken)) <= collateralAmount,
            "unexpected fees"
        );
        if (callbackSender == address(0)) {
            bridge.transferRemote(
                callbackDomain,
                callbackRecipient,
                collateralAmount
            );
        } else {
            MockRebalanceRouter(callbackSender).callbackTransfer(
                bridge,
                callbackDomain,
                callbackRecipient,
                collateralAmount
            );
        }
    }

    function callbackTransfer(
        ITokenBridge bridge,
        uint32 domain,
        bytes32 recipient,
        uint256 amount
    ) external {
        bridge.transferRemote(domain, recipient, amount);
    }

    function _toBytes32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}

contract AtomicLocalRebalancingBridgeTest is Test {
    uint32 internal constant LOCAL_DOMAIN = 10;

    AtomicLocalRebalancingBridge internal bridge;
    ERC20Test internal inputToken;
    ERC20Test internal outputToken;
    MockRebalanceRouter internal sourceRouter;
    MockRebalanceRouter internal destinationRouter;
    MockRebalanceRouter internal altDestinationRouter;
    TestSwapTarget internal swapTarget;

    address internal rebalancer = makeAddr("rebalancer");
    address internal other = makeAddr("other");

    function setUp() public {
        bridge = new AtomicLocalRebalancingBridge(
            LOCAL_DOMAIN,
            CallInvariant.RequiredDelta
        );
        inputToken = new ERC20Test("Input", "IN", 0, 6);
        outputToken = new ERC20Test("Output", "OUT", 0, 6);

        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
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
        sourceRouter.setCallbackRecipient(address(destinationRouter));

        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );

        inputToken.mintTo(address(sourceRouter), 1_000_000e6);
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        sourceRouter.approveTokenForBridge(bridge);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(bridge));
    }

    function test_localRebalance_revertsIfCallerNotSourceRebalancer() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(other);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.UnauthorizedRebalancer.selector
        );
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );
    }

    function test_localRebalance_allowsCallerWhitelistedOnSourceRouter()
        public
    {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );
        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
    }

    function test_localRebalance_integrationUsesRealSourceRouterRebalanceFlow()
        public
    {
        HypERC20Collateral source = new HypERC20Collateral(
            address(inputToken),
            1,
            1,
            address(new MockMailbox(LOCAL_DOMAIN))
        );
        HypERC20Collateral destination = new HypERC20Collateral(
            address(outputToken),
            1,
            1,
            address(new MockMailbox(LOCAL_DOMAIN))
        );
        source.initialize(address(0), address(0), address(this));
        destination.initialize(address(0), address(0), address(this));

        source.enrollRemoteRouter(
            LOCAL_DOMAIN,
            _toBytes32(address(destination))
        );
        source.addBridge(LOCAL_DOMAIN, bridge);
        source.addRebalancer(rebalancer);
        source.addRebalancer(address(bridge));

        inputToken.mintTo(address(source), 100e6);
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(source),
            100e6,
            _rebalancerCallsTo(100e6, address(destination), 100e6)
        );

        assertEq(inputToken.balanceOf(address(source)), 0);
        assertEq(inputToken.balanceOf(address(bridge)), 0);
        assertEq(outputToken.balanceOf(address(destination)), 100e6);
    }

    function test_localRebalance_usesSourceRecipient() public {
        MockRebalanceRouter unlisted = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setRecipient(LOCAL_DOMAIN, address(unlisted));
        sourceRouter.setCallbackRecipient(address(unlisted));
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsTo(100e6, address(unlisted), 100e6)
        );

        assertEq(outputToken.balanceOf(address(unlisted)), 100e6);
    }

    function test_localRebalance_revertsIfRouterDoesNotCallback() public {
        sourceRouter.setQuoteOnly(true);
        vm.prank(rebalancer);
        vm.expectRevert();
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );
    }

    function test_localRebalance_revertsIfAlreadyActive() public {
        sourceRouter.setReenter(true);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.RebalanceAlreadyActive.selector
        );
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );
    }

    function test_quoteTransferRemote_revertsForNonLocalDomain() public {
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidCallback.selector);
        bridge.quoteTransferRemote(LOCAL_DOMAIN + 1, bytes32(0), 100e6);
    }

    function test_transferRemote_revertsWithoutActiveRebalance() public {
        vm.expectRevert(
            AtomicLocalRebalancingBridge.NoActiveRebalance.selector
        );
        bridge.transferRemote(LOCAL_DOMAIN, bytes32(0), 100e6);
    }

    function test_transferRemote_revertsForNonLocalDomain() public {
        sourceRouter.setCallbackDomain(LOCAL_DOMAIN + 1);

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidCallback.selector);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );
    }

    function test_transferRemote_revertsForUnexpectedSourceRouter() public {
        sourceRouter.setCallbackSender(address(altDestinationRouter));

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidCallback.selector);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );
    }

    function test_transferRemote_ignoresRecipientAndPaysExactNominal() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 0);
        assertEq(inputToken.balanceOf(rebalancer), 0);
    }

    function test_transferRemote_coversShortfallFromRebalancerCall() public {
        swapTarget.setOutputAmount(97e6);
        outputToken.mintTo(rebalancer, 10e6);
        vm.prank(rebalancer);
        outputToken.approve(address(bridge), type(uint256).max);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsWithTopUp(100e6, 3e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 7e6);
    }

    function test_localRebalance_rebalancerCoversSwapCostInCalls() public {
        swapTarget.setOutputAmount(95e6);
        outputToken.mintTo(rebalancer, 5e6);
        vm.prank(rebalancer);
        outputToken.approve(address(bridge), 5e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsWithTopUp(100e6, 5e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 0);
        assertEq(outputToken.balanceOf(address(bridge)), 0);
    }

    function test_transferRemote_callsCanRefundSurplusToRebalancer() public {
        swapTarget.setOutputAmount(103e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsWithRefund(100e6, 3e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 3e6);
    }

    function test_transferRemote_revertsWhenOutputBelowRequiredOut() public {
        swapTarget.setOutputAmount(89e6);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InsufficientOutput.selector
        );
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsTo(100e6, address(destinationRouter), 89e6)
        );
    }

    function test_localRebalance_usesDecimalNormalizedRequiredDelta() public {
        outputToken = new ERC20Test("Output18", "OUT18", 0, 18);
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        swapTarget.setOutputAmount(100e18);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsTo(100e6, address(destinationRouter), 100e18)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e18);
    }

    function test_localRebalance_revertsWhenBelowDecimalNormalizedRequiredDelta()
        public
    {
        outputToken = new ERC20Test("Output18", "OUT18", 0, 18);
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InsufficientOutput.selector
        );
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsTo(100e6, address(destinationRouter), 100e6)
        );
    }

    function test_localRebalance_revertsForInvalidOutputToken() public {
        destinationRouter = new MockRebalanceRouter(
            ERC20Test(address(0)),
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(destinationRouter));

        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidToken.selector);
        bridge.localRebalance(address(sourceRouter), 100e6, noCalls);
    }

    function test_localRebalance_allowsDecimalNormalizedRequiredDeltaDown()
        public
    {
        inputToken = new ERC20Test("Input18", "IN18", 0, 18);
        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        inputToken.mintTo(address(sourceRouter), 1_000_000e18);
        sourceRouter.approveTokenForBridge(bridge);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(bridge));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        swapTarget.setOutputAmount(90e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            90e18,
            _rebalancerCallsTo(90e18, address(destinationRouter), 90e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 90e6);
    }

    function test_localRebalance_roundsRequiredDeltaUp() public {
        inputToken = new ERC20Test("Input18", "IN18", 0, 18);
        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        inputToken.mintTo(address(sourceRouter), 1_000_000e18);
        sourceRouter.approveTokenForBridge(bridge);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(bridge));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        swapTarget.setOutputAmount(2);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            1e12 + 1,
            _rebalancerCallsTo(1e12 + 1, address(destinationRouter), 2)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 2);
    }

    function test_transferRemote_withoutCallInvariantAllowsUnderpayment()
        public
    {
        bridge = new AtomicLocalRebalancingBridge(
            LOCAL_DOMAIN,
            CallInvariant.None
        );
        sourceRouter.approveTokenForBridge(bridge);
        sourceRouter.addRebalancer(address(bridge));
        swapTarget.setOutputAmount(89e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsTo(100e6, address(destinationRouter), 89e6)
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 89e6);
    }

    function test_transferRemote_revertsWhenRebalancerCallReverts() public {
        swapTarget.setShouldRevert(true);
        vm.prank(rebalancer);
        vm.expectRevert("TestSwapTarget: revert");
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );
    }

    function test_transferRemote_revertsIfOutputNotApproved() public {
        swapTarget.setOutputAmount(100e6);
        outputToken.mintTo(rebalancer, 1e6);

        vm.prank(rebalancer);
        vm.expectRevert("ERC20: insufficient allowance");
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsWithTopUp(100e6, 1e6)
        );
    }

    function test_transferRemote_revertsIfNoOutput() public {
        outputToken.mintTo(rebalancer, 100e6);

        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InsufficientOutput.selector
        );
        bridge.localRebalance(address(sourceRouter), 100e6, noCalls);
    }

    function test_transferRemote_keepsBridgeBalancesFlat() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCalls(100e6)
        );

        assertEq(inputToken.balanceOf(address(bridge)), 0);
        assertEq(outputToken.balanceOf(address(bridge)), 0);
    }

    function test_localRebalance_usesCrossCollateralEnrollmentPath() public {
        swapTarget.setOutputAmount(100e6);
        sourceRouter.setRecipient(LOCAL_DOMAIN, address(altDestinationRouter));
        sourceRouter.setCallbackRecipient(address(altDestinationRouter));

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            100e6,
            _rebalancerCallsTo(100e6, address(altDestinationRouter), 100e6)
        );

        assertEq(outputToken.balanceOf(address(altDestinationRouter)), 100e6);
    }

    function _rebalancerCalls(
        uint256 amountIn
    ) internal view returns (CallLib.Call[] memory calls) {
        return
            _rebalancerCallsTo(amountIn, address(destinationRouter), amountIn);
    }

    function _rebalancerCallsTo(
        uint256 amountIn,
        address destination,
        uint256 delta
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](3);
        calls[0] = CallLib.build(
            address(inputToken),
            0,
            abi.encodeCall(IERC20.approve, (address(swapTarget), amountIn))
        );
        calls[1] = CallLib.build(
            address(swapTarget),
            0,
            abi.encodeCall(TestSwapTarget.swapExactInput, (amountIn))
        );
        calls[2] = CallLib.build(
            address(outputToken),
            0,
            abi.encodeCall(IERC20.transfer, (destination, delta))
        );
    }

    function _rebalancerCallsWithTopUp(
        uint256 amountIn,
        uint256 topUp
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](4);
        CallLib.Call[] memory swapCalls = _rebalancerCallsTo(
            amountIn,
            address(destinationRouter),
            amountIn
        );
        calls[0] = swapCalls[0];
        calls[1] = swapCalls[1];
        calls[2] = CallLib.build(
            address(outputToken),
            0,
            abi.encodeCall(
                IERC20.transferFrom,
                (rebalancer, address(bridge), topUp)
            )
        );
        calls[3] = swapCalls[2];
    }

    function _rebalancerCallsWithRefund(
        uint256 amountIn,
        uint256 refund
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](4);
        CallLib.Call[] memory swapCalls = _rebalancerCalls(amountIn);
        calls[0] = swapCalls[0];
        calls[1] = swapCalls[1];
        calls[2] = swapCalls[2];
        calls[3] = CallLib.build(
            address(outputToken),
            0,
            abi.encodeCall(IERC20.transfer, (rebalancer, refund))
        );
    }

    function _toBytes32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}
