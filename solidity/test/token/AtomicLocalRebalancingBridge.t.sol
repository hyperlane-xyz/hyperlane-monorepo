// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {TestSwapTarget} from "contracts/test/TestSwapTarget.sol";
import {CallLib} from "contracts/middleware/libs/Call.sol";
import {AtomicLocalRebalancingBridge} from "contracts/token/AtomicLocalRebalancingBridge.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {ReentrancyGuardTransient} from "contracts/libs/ReentrancyGuardTransient.sol";
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
    bool public doubleCallback;

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

    function setDoubleCallback(bool _doubleCallback) external {
        doubleCallback = _doubleCallback;
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
                collateralAmount,
                calls
            );
        }
        if (quoteOnly) return;
        require(
            quotes.extract(address(wrappedToken)) <= collateralAmount,
            "unexpected fees"
        );
        uint256 approval = quotes.extract(address(wrappedToken));
        wrappedToken.approve(address(bridge), approval);
        if (callbackSender == address(0)) {
            bridge.transferRemote(
                callbackDomain,
                callbackRecipient,
                collateralAmount
            );
            if (doubleCallback) {
                bridge.transferRemote(
                    callbackDomain,
                    callbackRecipient,
                    collateralAmount
                );
            }
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

contract ReentrantCallTarget {
    AtomicLocalRebalancingBridge public immutable bridge;

    constructor(AtomicLocalRebalancingBridge _bridge) {
        bridge = _bridge;
    }

    function reenter() external {
        CallLib.Call[] memory empty = new CallLib.Call[](0);
        bridge.localRebalance(1, empty);
    }
}

contract NonReceivingRebalancer {
    function rebalanceWithValue(
        AtomicLocalRebalancingBridge target,
        uint256 amountIn,
        CallLib.Call[] calldata calls
    ) external payable {
        target.localRebalance{value: msg.value}(amountIn, calls);
    }
}

contract NativeSink {
    receive() external payable {}
}

contract AtomicLocalRebalancingBridgeTest is Test {
    uint32 internal constant LOCAL_DOMAIN = 10;

    AtomicLocalRebalancingBridge internal bridge;
    ERC20Test internal inputToken;
    ERC20Test internal outputToken;
    MockRebalanceRouter internal sourceRouter;
    MockRebalanceRouter internal destinationRouter;
    MockRebalanceRouter internal altDestinationRouter;
    MockRebalanceRouter internal unrelatedRouter;
    TestSwapTarget internal swapTarget;

    address internal rebalancer = makeAddr("rebalancer");
    address internal other = makeAddr("other");

    function setUp() public {
        inputToken = new ERC20Test("Input", "IN", 0, 6);
        outputToken = new ERC20Test("Output", "OUT", 0, 6);

        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
        bridge = new AtomicLocalRebalancingBridge(
            LOCAL_DOMAIN,
            address(sourceRouter)
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
        sourceRouter.setCallbackRecipient(address(destinationRouter));

        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );

        inputToken.mintTo(address(sourceRouter), 1_000_000e6);
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(bridge));
    }

    function test_localRebalance_revertsIfCallerNotSourceRebalancer() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(other);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.UnauthorizedRebalancer.selector
        );
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_localRebalance_allowsCallerWhitelistedOnSourceRouter()
        public
    {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
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

        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(source)
            );

        source.enrollRemoteRouter(
            LOCAL_DOMAIN,
            _toBytes32(address(destination))
        );
        source.addBridge(LOCAL_DOMAIN, localBridge);
        source.addRebalancer(rebalancer);
        source.addRebalancer(address(localBridge));

        inputToken.mintTo(address(source), 100e6);
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        localBridge.localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(inputToken.balanceOf(address(source)), 0);
        assertEq(inputToken.balanceOf(address(localBridge)), 0);
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
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(outputToken.balanceOf(address(unlisted)), 100e6);
    }

    function test_localRebalance_revertsIfRouterDoesNotCallback() public {
        sourceRouter.setQuoteOnly(true);
        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.MissingCallback.selector);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_localRebalance_revertsIfRouterCallbacksTwice() public {
        sourceRouter.setDoubleCallback(true);
        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidCallback.selector);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_localRebalance_revertsIfAlreadyActive() public {
        sourceRouter.setReenter(true);

        vm.prank(rebalancer);
        vm.expectRevert(
            ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector
        );
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_localRebalance_revertsOnReentrancyDuringCalls() public {
        ReentrantCallTarget target = new ReentrantCallTarget(bridge);

        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            address(target),
            0,
            abi.encodeCall(ReentrantCallTarget.reenter, ())
        );

        vm.prank(rebalancer);
        vm.expectRevert(
            ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector
        );
        bridge.localRebalance(100e6, calls);
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
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_transferRemote_revertsForUnexpectedSourceRouter() public {
        sourceRouter.setCallbackSender(address(altDestinationRouter));

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidCallback.selector);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_transferRemote_ignoresRecipientAndPaysExactNominal() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));

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
        bridge.localRebalance(100e6, _rebalancerCallsWithTopUp(100e6, 3e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 7e6);
    }

    function test_localRebalance_rebalancerCoversSwapCostInCalls() public {
        swapTarget.setOutputAmount(95e6);
        outputToken.mintTo(rebalancer, 5e6);
        vm.prank(rebalancer);
        outputToken.approve(address(bridge), 5e6);

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, _rebalancerCallsWithTopUp(100e6, 5e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 0);
        assertEq(outputToken.balanceOf(address(bridge)), 0);
    }

    function test_transferRemote_refundsSurplusToRebalancer() public {
        swapTarget.setOutputAmount(103e6);

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 3e6);
    }

    function test_transferRemote_sweepsSurplusOutputToRebalancer() public {
        swapTarget.setOutputAmount(103e6);

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 3e6);
        assertEq(outputToken.balanceOf(address(bridge)), 0);
    }

    function test_transferRemote_refundsSurplusButKeepsDonation() public {
        // A prior donation of the output token sits on the bridge.
        outputToken.mintTo(address(bridge), 50e6);
        // Calls produce 3e6 more output than requiredDelta.
        swapTarget.setOutputAmount(103e6);

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));

        // Destination gets requiredDelta, only the produced surplus is refunded,
        // and the donation stays on the bridge.
        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 3e6);
        assertEq(outputToken.balanceOf(address(bridge)), 50e6);
    }

    function test_transferRemote_sweepsSurplusInputToRebalancer() public {
        outputToken.mintTo(rebalancer, 100e6);
        vm.prank(rebalancer);
        outputToken.approve(address(bridge), 100e6);

        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            address(outputToken),
            0,
            abi.encodeCall(
                IERC20.transferFrom,
                (rebalancer, address(bridge), 100e6)
            )
        );

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, calls);

        assertEq(inputToken.balanceOf(rebalancer), 100e6);
        assertEq(inputToken.balanceOf(address(bridge)), 0);
        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
    }

    function test_transferRemote_sweepsSurplusSharedTokenToRebalancer() public {
        destinationRouter = new MockRebalanceRouter(
            inputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        inputToken.mintTo(rebalancer, 100e6);
        vm.prank(rebalancer);
        inputToken.approve(address(bridge), 100e6);

        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            address(inputToken),
            0,
            abi.encodeCall(
                IERC20.transferFrom,
                (rebalancer, address(bridge), 100e6)
            )
        );

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, calls);

        assertEq(inputToken.balanceOf(rebalancer), 100e6);
        assertEq(inputToken.balanceOf(address(bridge)), 0);
        assertEq(inputToken.balanceOf(address(destinationRouter)), 100e6);
    }

    function test_transferRemote_revertsWhenOutputBelowRequiredOut() public {
        swapTarget.setOutputAmount(89e6);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InsufficientOutput.selector
        );
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_localRebalance_revertsWhenDestinationFundedByDonation()
        public
    {
        // A prior donation of the output token sits on the bridge.
        outputToken.mintTo(address(bridge), 100e6);

        // Calls produce no new output: the rebalancer tries to satisfy the
        // destination from the donation while pocketing the escrowed input.
        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InsufficientOutput.selector
        );
        bridge.localRebalance(100e6, noCalls);
    }

    function test_localRebalance_sharedTokenFundsFromEscrowAndKeepsDonation()
        public
    {
        // input == output: destination holds the same token as the source, so
        // the escrow itself funds the destination with no swap.
        MockRebalanceRouter sameTokenDest = new MockRebalanceRouter(
            inputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(sameTokenDest));

        // A prior donation of the shared token sits on the bridge.
        inputToken.mintTo(address(bridge), 50e6);

        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, noCalls);

        // Escrow funds the destination; the donation is preserved, not swept.
        assertEq(inputToken.balanceOf(address(sameTokenDest)), 100e6);
        assertEq(inputToken.balanceOf(address(bridge)), 50e6);
        assertEq(inputToken.balanceOf(rebalancer), 0);
    }

    function test_localRebalance_refundsUnspentNative() public {
        swapTarget.setOutputAmount(100e6);
        vm.deal(rebalancer, 1 ether);
        uint256 balanceBefore = rebalancer.balance;

        vm.prank(rebalancer);
        bridge.localRebalance{value: 1 ether}(100e6, _rebalancerCalls(100e6));

        assertEq(rebalancer.balance, balanceBefore);
        assertEq(address(bridge).balance, 0);
    }

    function test_localRebalance_doesNotRefundPreExistingNative() public {
        swapTarget.setOutputAmount(100e6);
        vm.deal(address(bridge), 5 ether);
        vm.deal(rebalancer, 1 ether);
        uint256 balanceBefore = rebalancer.balance;

        vm.prank(rebalancer);
        bridge.localRebalance{value: 1 ether}(100e6, _rebalancerCalls(100e6));

        assertEq(rebalancer.balance, balanceBefore);
        assertEq(address(bridge).balance, 5 ether);
    }

    function test_localRebalance_revertsIfCallsSpendPreExistingNative() public {
        swapTarget.setOutputAmount(100e6);
        NativeSink sink = new NativeSink();
        vm.deal(address(bridge), 5 ether);

        CallLib.Call[] memory calls = new CallLib.Call[](3);
        CallLib.Call[] memory rebalanceCalls = _rebalancerCalls(100e6);
        calls[0] = rebalanceCalls[0];
        calls[1] = rebalanceCalls[1];
        calls[2] = CallLib.build(
            address(sink),
            CallLib.NATIVE_BALANCE_SENTINEL,
            ""
        );

        vm.deal(rebalancer, 1 ether);
        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InvalidNativeDelta.selector
        );
        bridge.localRebalance{value: 1 ether}(100e6, calls);
    }

    function test_localRebalance_revertsWhenNativeRefundFails() public {
        swapTarget.setOutputAmount(100e6);
        NonReceivingRebalancer caller = new NonReceivingRebalancer();
        sourceRouter.addRebalancer(address(caller));
        vm.deal(address(caller), 1 ether);

        vm.expectRevert(
            "Address: unable to send value, recipient may have reverted"
        );
        caller.rebalanceWithValue{value: 1 ether}(
            bridge,
            100e6,
            _rebalancerCalls(100e6)
        );
    }

    function test_transferRemote_revertsIfCallsBridgeOutThroughDestinationRouter()
        public
    {
        MockMailbox localMailbox = new MockMailbox(LOCAL_DOMAIN);
        localMailbox.addRemoteMailbox(
            LOCAL_DOMAIN + 1,
            new MockMailbox(LOCAL_DOMAIN + 1)
        );

        HypERC20Collateral source = new HypERC20Collateral(
            address(inputToken),
            1,
            1,
            address(localMailbox)
        );
        HypERC20Collateral destination = new HypERC20Collateral(
            address(outputToken),
            1,
            1,
            address(localMailbox)
        );
        source.initialize(address(0), address(0), address(this));
        destination.initialize(address(0), address(0), address(this));
        source.enrollRemoteRouter(
            LOCAL_DOMAIN,
            _toBytes32(address(destination))
        );
        destination.enrollRemoteRouter(
            LOCAL_DOMAIN + 1,
            _toBytes32(rebalancer)
        );
        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(source)
            );
        source.addBridge(LOCAL_DOMAIN, localBridge);
        source.addRebalancer(rebalancer);
        source.addRebalancer(address(localBridge));
        inputToken.mintTo(address(source), 100e6);
        swapTarget.setOutputAmount(100e6);

        CallLib.Call[] memory calls = new CallLib.Call[](4);
        CallLib.Call[] memory rebalanceCalls = _rebalancerCalls(100e6);
        calls[0] = rebalanceCalls[0];
        calls[1] = rebalanceCalls[1];
        calls[2] = CallLib.build(
            address(outputToken),
            0,
            abi.encodeCall(IERC20.approve, (address(destination), 100e6))
        );
        calls[3] = CallLib.build(
            address(destination),
            0,
            abi.encodeCall(
                ITokenBridge.transferRemote,
                (LOCAL_DOMAIN + 1, _toBytes32(rebalancer), 100e6)
            )
        );

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InsufficientOutput.selector
        );
        localBridge.localRebalance(100e6, calls);
    }

    function test_transferRemote_revertsWhenCallsDrainSourceCollateral()
        public
    {
        swapTarget.setOutputAmount(100e6);

        CallLib.Call[] memory calls = new CallLib.Call[](3);
        CallLib.Call[] memory rebalanceCalls = _rebalancerCalls(100e6);
        calls[0] = rebalanceCalls[0];
        calls[1] = rebalanceCalls[1];
        calls[2] = CallLib.build(
            address(inputToken),
            0,
            abi.encodeCall(
                IERC20.transferFrom,
                (address(sourceRouter), other, 1e6)
            )
        );

        vm.prank(rebalancer);
        vm.expectRevert("ERC20: insufficient allowance");
        bridge.localRebalance(100e6, calls);
    }

    function test_transferRemote_revertsWhenCallsDrainUnrelatedRoute() public {
        swapTarget.setOutputAmount(100e6);
        unrelatedRouter = new MockRebalanceRouter(
            inputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        inputToken.mintTo(address(unrelatedRouter), 1_000e6);
        CallLib.Call[] memory calls = new CallLib.Call[](3);
        CallLib.Call[] memory rebalanceCalls = _rebalancerCalls(100e6);
        calls[0] = rebalanceCalls[0];
        calls[1] = rebalanceCalls[1];
        calls[2] = CallLib.build(
            address(inputToken),
            0,
            abi.encodeCall(
                IERC20.transferFrom,
                (address(unrelatedRouter), other, 1e6)
            )
        );

        vm.prank(rebalancer);
        vm.expectRevert("ERC20: insufficient allowance");
        bridge.localRebalance(100e6, calls);
    }

    function test_transferRemote_allowsCallsToTopUpSourceCollateral() public {
        swapTarget.setOutputAmount(100e6);
        inputToken.mintTo(rebalancer, 1e6);
        vm.prank(rebalancer);
        inputToken.approve(address(bridge), 1e6);

        CallLib.Call[] memory calls = new CallLib.Call[](3);
        CallLib.Call[] memory rebalanceCalls = _rebalancerCalls(100e6);
        calls[0] = rebalanceCalls[0];
        calls[1] = rebalanceCalls[1];
        calls[2] = CallLib.build(
            address(inputToken),
            0,
            abi.encodeCall(
                IERC20.transferFrom,
                (rebalancer, address(sourceRouter), 1e6)
            )
        );

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, calls);

        assertEq(inputToken.balanceOf(address(sourceRouter)), 999_901e6);
        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
    }

    function testFuzz_localRebalance_doesNotDecreaseRouterTokenSum(
        bytes32 actions,
        uint256 rawAmountIn
    ) public {
        uint256 amountIn = bound(rawAmountIn, 1, 1_000e6);
        ERC20Test sharedToken = new ERC20Test("Shared", "SHR", 0, 6);

        inputToken = sharedToken;
        outputToken = sharedToken;
        sourceRouter = new MockRebalanceRouter(sharedToken, LOCAL_DOMAIN, 1, 1);
        destinationRouter = new MockRebalanceRouter(
            sharedToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        unrelatedRouter = new MockRebalanceRouter(
            sharedToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(sourceRouter)
            );
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(localBridge));

        sharedToken.mintTo(address(sourceRouter), 1_000_000e6);
        sharedToken.mintTo(address(destinationRouter), 1_000e6);
        sharedToken.mintTo(address(unrelatedRouter), 1_000e6);
        sharedToken.mintTo(rebalancer, 1_000_000e6);
        sharedToken.mintTo(other, 1_000_000e6);
        vm.prank(rebalancer);
        sharedToken.approve(address(localBridge), type(uint256).max);
        vm.prank(other);
        sharedToken.approve(address(localBridge), type(uint256).max);

        CallLib.Call[] memory calls = new CallLib.Call[](8);
        for (uint256 i = 0; i < 8; ++i) {
            calls[i] = _adversarialTokenCall(
                sharedToken,
                uint8(actions[i]),
                (uint256(uint8(actions[i + 8])) * amountIn) / type(uint8).max
            );
        }

        uint256 routerSumBefore = sharedToken.balanceOf(address(sourceRouter)) +
            sharedToken.balanceOf(address(destinationRouter)) +
            sharedToken.balanceOf(address(unrelatedRouter));

        vm.prank(rebalancer);
        try localBridge.localRebalance(amountIn, calls) {
            assertGe(
                sharedToken.balanceOf(address(sourceRouter)) +
                    sharedToken.balanceOf(address(destinationRouter)) +
                    sharedToken.balanceOf(address(unrelatedRouter)),
                routerSumBefore
            );
        } catch {}
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
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));

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
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
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
        bridge.localRebalance(100e6, noCalls);
    }

    function test_localRebalance_revertsForInvalidInputToken() public {
        sourceRouter = new MockRebalanceRouter(
            ERC20Test(address(0)),
            LOCAL_DOMAIN,
            1,
            1
        );
        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(sourceRouter)
            );
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(localBridge));

        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidToken.selector);
        localBridge.localRebalance(100e6, noCalls);
    }

    function test_localRebalance_allowsDecimalNormalizedRequiredDeltaDown()
        public
    {
        inputToken = new ERC20Test("Input18", "IN18", 0, 18);
        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(sourceRouter)
            );
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        inputToken.mintTo(address(sourceRouter), 1_000_000e18);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(localBridge));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        swapTarget.setOutputAmount(90e6);

        vm.prank(rebalancer);
        localBridge.localRebalance(90e18, _rebalancerCalls(90e18));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 90e6);
    }

    function test_localRebalance_roundsRequiredDeltaUp() public {
        inputToken = new ERC20Test("Input18", "IN18", 0, 18);
        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(sourceRouter)
            );
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        inputToken.mintTo(address(sourceRouter), 1_000_000e18);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(localBridge));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        swapTarget.setOutputAmount(2);

        vm.prank(rebalancer);
        localBridge.localRebalance(1e12 + 1, _rebalancerCalls(1e12 + 1));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 2);
    }

    function test_transferRemote_revertsWhenRebalancerCallReverts() public {
        swapTarget.setShouldRevert(true);
        vm.prank(rebalancer);
        vm.expectRevert("TestSwapTarget: revert");
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_transferRemote_revertsIfOutputNotApproved() public {
        swapTarget.setOutputAmount(100e6);
        outputToken.mintTo(rebalancer, 1e6);

        vm.prank(rebalancer);
        vm.expectRevert("ERC20: insufficient allowance");
        bridge.localRebalance(100e6, _rebalancerCallsWithTopUp(100e6, 1e6));
    }

    function test_transferRemote_revertsIfNoOutput() public {
        outputToken.mintTo(rebalancer, 100e6);

        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InsufficientOutput.selector
        );
        bridge.localRebalance(100e6, noCalls);
    }

    function test_transferRemote_keepsBridgeBalancesFlat() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(inputToken.balanceOf(address(bridge)), 0);
        assertEq(outputToken.balanceOf(address(bridge)), 0);
    }

    function test_localRebalance_usesCrossCollateralEnrollmentPath() public {
        swapTarget.setOutputAmount(100e6);
        sourceRouter.setRecipient(LOCAL_DOMAIN, address(altDestinationRouter));
        sourceRouter.setCallbackRecipient(address(altDestinationRouter));

        vm.prank(rebalancer);
        bridge.localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(outputToken.balanceOf(address(altDestinationRouter)), 100e6);
    }

    function _rebalancerCalls(
        uint256 amountIn
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](2);
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
    }

    function _rebalancerCallsWithTopUp(
        uint256 amountIn,
        uint256 topUp
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](3);
        CallLib.Call[] memory swapCalls = _rebalancerCalls(amountIn);
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
    }

    function _adversarialTokenCall(
        ERC20Test token,
        uint8 action,
        uint256 amount
    ) internal view returns (CallLib.Call memory) {
        action = action % 11;
        if (action == 0) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(IERC20.approve, (other, amount))
                );
        }
        if (action == 1) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(IERC20.approve, (rebalancer, amount))
                );
        }
        if (action == 2) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(IERC20.transfer, (other, amount))
                );
        }
        if (action == 3) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(
                        IERC20.transfer,
                        (address(destinationRouter), amount)
                    )
                );
        }
        if (action == 4) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(
                        IERC20.transferFrom,
                        (address(sourceRouter), other, amount)
                    )
                );
        }
        if (action == 5) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(
                        IERC20.transferFrom,
                        (
                            address(sourceRouter),
                            address(destinationRouter),
                            amount
                        )
                    )
                );
        }
        if (action == 6) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(
                        IERC20.transferFrom,
                        (address(destinationRouter), other, amount)
                    )
                );
        }
        if (action == 7) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(
                        IERC20.transferFrom,
                        (rebalancer, address(destinationRouter), amount)
                    )
                );
        }
        if (action == 8) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(
                        IERC20.transferFrom,
                        (address(unrelatedRouter), other, amount)
                    )
                );
        }
        if (action == 9) {
            return
                CallLib.build(
                    address(token),
                    0,
                    abi.encodeCall(
                        IERC20.transferFrom,
                        (rebalancer, address(sourceRouter), amount)
                    )
                );
        }
        return
            CallLib.build(
                address(token),
                0,
                abi.encodeCall(
                    IERC20.transferFrom,
                    (other, address(destinationRouter), amount)
                )
            );
    }

    function _toBytes32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}
