// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {TestSwapTarget} from "contracts/test/TestSwapTarget.sol";
import {CallLib} from "contracts/middleware/libs/Call.sol";
import {AtomicLocalRebalancingBridge} from "contracts/token/AtomicLocalRebalancingBridge.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {CrossCollateralRouter} from "contracts/token/CrossCollateralRouter.sol";
import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {ReentrancyGuardTransient} from "contracts/libs/ReentrancyGuardTransient.sol";
import {Quotes} from "contracts/token/libs/Quotes.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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
    uint256 public postCallbackApproval;

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

    /// @notice Mirrors CrossCollateralRouter: the enrolled primary router or any
    /// cross-collateral router is a valid rebalance target.
    function isRebalanceTarget(
        uint32 domain,
        bytes32 target
    ) external view returns (bool) {
        return
            target == routers[domain] || crossCollateralRouters[domain][target];
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

    function setPostCallbackApproval(uint256 _postCallbackApproval) external {
        postCallbackApproval = _postCallbackApproval;
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
            AtomicLocalRebalancingBridge(address(bridge)).rebalance(
                localDomain,
                collateralAmount,
                ITokenBridge(address(this)),
                callbackRecipient,
                ""
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
            if (postCallbackApproval > 0) {
                wrappedToken.approve(address(bridge), postCallbackApproval);
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
        // nonReentrant reverts before any argument is validated, so the source
        // and recipient values are immaterial here.
        bridge.rebalance(
            bridge.localDomain(),
            1,
            ITokenBridge(bridge.allowedSourceRouter()),
            bytes32(0),
            ""
        );
    }
}

contract NativeSink {
    receive() external payable {}
}

contract NonReceivingRebalancer {
    function rebalanceWithValue(
        AtomicLocalRebalancingBridge target,
        ITokenBridge source,
        bytes32 destinationRecipient,
        uint256 amountIn,
        CallLib.Call[] calldata calls
    ) external payable {
        target.rebalance{value: msg.value}(
            target.localDomain(),
            amountIn,
            source,
            destinationRecipient,
            abi.encode(calls)
        );
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
    MockRebalanceRouter internal unrelatedRouter;
    TestSwapTarget internal swapTarget;

    address internal rebalancer = makeAddr("rebalancer");
    address internal other = makeAddr("other");
    address internal bridgeOwner = makeAddr("bridgeOwner");

    function setUp() public {
        inputToken = new ERC20Test("Input", "IN", 0, 6);
        outputToken = new ERC20Test("Output", "OUT", 0, 6);

        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
        bridge = new AtomicLocalRebalancingBridge(
            LOCAL_DOMAIN,
            address(sourceRouter),
            bridgeOwner
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

    function test_rebalance_revertsIfCallerNotSourceRebalancer() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(other);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.UnauthorizedRebalancer.selector
        );
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_rebalance_revertsForInvalidSource() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidSource.selector);
        bridge.rebalance(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(destinationRouter)),
            _toBytes32(address(destinationRouter)),
            abi.encode(_rebalancerCalls(100e6))
        );
    }

    function test_rebalance_revertsForNonLocalDomain() public {
        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidCallback.selector);
        bridge.rebalance(
            LOCAL_DOMAIN + 1,
            100e6,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(destinationRouter)),
            abi.encode(_rebalancerCalls(100e6))
        );
    }

    function test_rebalance_revertsForUnregisteredRecipient() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidRecipient.selector);
        bridge.rebalance(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(0xdead)),
            abi.encode(_rebalancerCalls(100e6))
        );
    }

    function test_constructor_revertsForNonContractSource() public {
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidSource.selector);
        new AtomicLocalRebalancingBridge(
            LOCAL_DOMAIN,
            address(0xdead),
            bridgeOwner
        );
    }

    function test_constructor_revertsForZeroOwner() public {
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidOwner.selector);
        new AtomicLocalRebalancingBridge(
            LOCAL_DOMAIN,
            address(sourceRouter),
            address(0)
        );
    }

    function test_rebalance_allowsCallerWhitelistedOnSourceRouter() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));
        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
    }

    function test_rebalance_emitsLocalRebalanceExecuted() public {
        swapTarget.setOutputAmount(100e6);

        vm.expectEmit(true, true, true, true, address(bridge));
        emit AtomicLocalRebalancingBridge.LocalRebalanceExecuted(
            address(destinationRouter),
            100e6,
            100e6
        );

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_rebalance_integrationUsesRealSourceRouterRebalanceFlow()
        public
    {
        CrossCollateralRouter source = new CrossCollateralRouter(
            address(inputToken),
            1,
            1,
            address(new MockMailbox(LOCAL_DOMAIN))
        );
        CrossCollateralRouter destination = new CrossCollateralRouter(
            address(outputToken),
            1,
            1,
            address(new MockMailbox(LOCAL_DOMAIN))
        );
        source.initialize(address(0), address(0), address(this));
        destination.initialize(address(0), address(0), address(this));

        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(source),
                bridgeOwner
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
        localBridge.rebalance(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(source)),
            _toBytes32(address(destination)),
            abi.encode(_rebalancerCalls(100e6))
        );

        assertEq(inputToken.balanceOf(address(source)), 0);
        assertEq(inputToken.balanceOf(address(localBridge)), 0);
        assertEq(outputToken.balanceOf(address(destination)), 100e6);
    }

    function test_rebalance_paysParamRecipientNotCallbackRecipient() public {
        swapTarget.setOutputAmount(100e6);
        // The source's own configured recipient differs from the param: the
        // bridge ignores the callback recipient and funds the validated param.
        sourceRouter.setCallbackRecipient(address(altDestinationRouter));

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(address(altDestinationRouter)), 0);
    }

    function test_rebalance_revertsIfRouterDoesNotCallback() public {
        sourceRouter.setQuoteOnly(true);
        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.MissingCallback.selector);
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_rebalance_revertsIfRouterCallbacksTwice() public {
        sourceRouter.setDoubleCallback(true);
        vm.prank(rebalancer);
        // The first callback consumes the active slot; the second sees no active
        // rebalance.
        vm.expectRevert(
            AtomicLocalRebalancingBridge.NoActiveRebalance.selector
        );
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_rebalance_revertsIfAlreadyActive() public {
        sourceRouter.setReenter(true);

        vm.prank(rebalancer);
        vm.expectRevert(
            ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector
        );
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_rebalance_revertsOnReentrancyDuringCalls() public {
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
        _localRebalance(100e6, calls);
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
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_transferRemote_revertsForUnexpectedSourceRouter() public {
        sourceRouter.setCallbackSender(address(altDestinationRouter));

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidCallback.selector);
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_transferRemote_ignoresRecipientAndPaysExactNominal() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));

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
        _localRebalance(100e6, _rebalancerCallsWithTopUp(100e6, 3e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 7e6);
    }

    function test_rebalance_rebalancerCoversSwapCostInCalls() public {
        swapTarget.setOutputAmount(95e6);
        outputToken.mintTo(rebalancer, 5e6);
        vm.prank(rebalancer);
        outputToken.approve(address(bridge), 5e6);

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCallsWithTopUp(100e6, 5e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 0);
        assertEq(outputToken.balanceOf(address(bridge)), 0);
    }

    function test_transferRemote_refundsSurplusToRebalancer() public {
        swapTarget.setOutputAmount(103e6);

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 3e6);
    }

    function test_transferRemote_sweepsSurplusOutputToRebalancer() public {
        swapTarget.setOutputAmount(103e6);

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
        assertEq(outputToken.balanceOf(rebalancer), 3e6);
        assertEq(outputToken.balanceOf(address(bridge)), 0);
    }

    function test_transferRemote_refundsSurplusKeepsPreexistingBalance()
        public
    {
        // A pre-existing output-token balance sits on the bridge.
        outputToken.mintTo(address(bridge), 50e6);
        // Calls produce 3e6 more output than requiredOutputAmount.
        swapTarget.setOutputAmount(103e6);

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));

        // Destination gets requiredOutputAmount, only the produced surplus is
        // refunded, and the pre-existing balance is left untouched on the bridge.
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
        _localRebalance(100e6, calls);

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
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));
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
        _localRebalance(100e6, calls);

        assertEq(inputToken.balanceOf(rebalancer), 100e6);
        assertEq(inputToken.balanceOf(address(bridge)), 0);
        assertEq(inputToken.balanceOf(address(destinationRouter)), 100e6);
    }

    function test_transferRemote_revertsWhenOutputBelowRequiredOut() public {
        swapTarget.setOutputAmount(89e6);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge
                .InsufficientOutputTokenProduced
                .selector
        );
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_rebalance_revertsWhenDestinationFundedByPreexistingBalance()
        public
    {
        // A pre-existing output-token balance sits on the bridge.
        outputToken.mintTo(address(bridge), 100e6);

        // Calls produce no new output: the rebalancer tries to satisfy the
        // destination from the pre-existing balance while pocketing the escrowed
        // input.
        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge
                .InsufficientOutputTokenProduced
                .selector
        );
        _localRebalance(100e6, noCalls);
    }

    function test_rebalance_revertsWhenCallsSpendPreexistingInput() public {
        // A pre-existing input-token balance sits on the bridge.
        inputToken.mintTo(address(bridge), 50e6);
        // Swap the escrow AND the pre-existing balance, so the surplus output would
        // be refunded to the rebalancer if the pre-existing input were spendable.
        swapTarget.setOutputAmount(150e6);

        CallLib.Call[] memory calls = new CallLib.Call[](2);
        calls[0] = CallLib.build(
            address(inputToken),
            0,
            abi.encodeCall(IERC20.approve, (address(swapTarget), 150e6))
        );
        calls[1] = CallLib.build(
            address(swapTarget),
            0,
            abi.encodeCall(TestSwapTarget.swapExactInput, (150e6))
        );

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.PreexistingSourceTokenSpent.selector
        );
        _localRebalance(100e6, calls);
    }

    function test_rebalance_sharedTokenFundsFromEscrowKeepsPreexistingBalance()
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
        sourceRouter.setCrossRouter(LOCAL_DOMAIN, address(sameTokenDest), true);
        sourceRouter.setCallbackRecipient(address(sameTokenDest));

        // A pre-existing balance of the shared token sits on the bridge.
        inputToken.mintTo(address(bridge), 50e6);

        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        bridge.rebalance(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(sameTokenDest)),
            abi.encode(noCalls)
        );

        // Escrow funds the destination; the pre-existing balance is left untouched
        // on the bridge and nothing is refunded to the rebalancer.
        assertEq(inputToken.balanceOf(address(sameTokenDest)), 100e6);
        assertEq(inputToken.balanceOf(address(bridge)), 50e6);
        assertEq(inputToken.balanceOf(rebalancer), 0);
    }

    function test_rebalance_refundsUnspentNative() public {
        swapTarget.setOutputAmount(100e6);
        vm.deal(rebalancer, 1 ether);
        uint256 balanceBefore = rebalancer.balance;

        vm.prank(rebalancer);
        bridge.rebalance{value: 1 ether}(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(destinationRouter)),
            abi.encode(_rebalancerCalls(100e6))
        );

        assertEq(rebalancer.balance, balanceBefore);
        assertEq(address(bridge).balance, 0);
    }

    function test_rebalance_doesNotRefundPreExistingNative() public {
        swapTarget.setOutputAmount(100e6);
        // Native already on the bridge before the call.
        vm.deal(address(bridge), 5 ether);
        vm.deal(rebalancer, 1 ether);
        uint256 balanceBefore = rebalancer.balance;

        vm.prank(rebalancer);
        bridge.rebalance{value: 1 ether}(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(destinationRouter)),
            abi.encode(_rebalancerCalls(100e6))
        );

        // Unspent msg.value is refunded; the pre-existing 5 ether is left untouched.
        assertEq(rebalancer.balance, balanceBefore);
        assertEq(address(bridge).balance, 5 ether);
    }

    function test_rebalance_revertsIfCallsSpendPreExistingNative() public {
        swapTarget.setOutputAmount(100e6);
        NativeSink sink = new NativeSink();
        // Native already on the bridge before the call.
        vm.deal(address(bridge), 5 ether);

        CallLib.Call[] memory calls = new CallLib.Call[](3);
        CallLib.Call[] memory rebalanceCalls = _rebalancerCalls(100e6);
        calls[0] = rebalanceCalls[0];
        calls[1] = rebalanceCalls[1];
        // Drains the bridge's entire native balance, dipping into the pre-existing
        // balance beyond this call's msg.value.
        calls[2] = CallLib.build(
            address(sink),
            CallLib.NATIVE_BALANCE_SENTINEL,
            ""
        );

        vm.deal(rebalancer, 1 ether);
        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.PreexistingNativeBalanceSpent.selector
        );
        bridge.rebalance{value: 1 ether}(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(destinationRouter)),
            abi.encode(calls)
        );
    }

    function test_rebalance_revertsWhenNativeRefundFails() public {
        swapTarget.setOutputAmount(100e6);
        NonReceivingRebalancer caller = new NonReceivingRebalancer();
        sourceRouter.addRebalancer(address(caller));
        vm.deal(address(caller), 1 ether);

        vm.expectRevert(
            "Address: unable to send value, recipient may have reverted"
        );
        caller.rebalanceWithValue{value: 1 ether}(
            bridge,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(destinationRouter)),
            100e6,
            _rebalancerCalls(100e6)
        );
    }

    function test_recoverToken_sendsStrayBalanceToRecipient() public {
        address recipient = makeAddr("recipient");
        inputToken.mintTo(address(bridge), 50e6);

        vm.prank(bridgeOwner);
        bridge.recoverToken(inputToken, recipient);

        assertEq(inputToken.balanceOf(recipient), 50e6);
        assertEq(inputToken.balanceOf(address(bridge)), 0);
    }

    function test_recoverToken_revertsForNonOwner() public {
        inputToken.mintTo(address(bridge), 50e6);

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        bridge.recoverToken(inputToken, other);
    }

    function test_recoverNativeBalance_sendsStrayBalanceToRecipient() public {
        address recipient = makeAddr("recipient");
        vm.deal(address(bridge), 3 ether);

        vm.prank(bridgeOwner);
        bridge.recoverNativeBalance(recipient);

        assertEq(recipient.balance, 3 ether);
        assertEq(address(bridge).balance, 0);
    }

    function test_recoverNativeBalance_revertsForNonOwner() public {
        vm.deal(address(bridge), 3 ether);

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        bridge.recoverNativeBalance(other);
    }

    function test_recoverToken_revertsWhenCalledDuringRebalance() public {
        // Even with the gate satisfied (owner == bridge), the rebalance's
        // transient lock blocks recovery reached through the rebalancer calls.
        vm.prank(bridgeOwner);
        bridge.transferOwnership(address(bridge));

        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            address(bridge),
            0,
            abi.encodeCall(bridge.recoverToken, (inputToken, other))
        );

        vm.prank(rebalancer);
        vm.expectRevert(
            ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector
        );
        _localRebalance(100e6, calls);
    }

    function test_rebalance_revertsIfCallsBridgeOutThroughDestinationRouter()
        public
    {
        MockMailbox localMailbox = new MockMailbox(LOCAL_DOMAIN);
        localMailbox.addRemoteMailbox(
            LOCAL_DOMAIN + 1,
            new MockMailbox(LOCAL_DOMAIN + 1)
        );

        CrossCollateralRouter source = new CrossCollateralRouter(
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
                address(source),
                bridgeOwner
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
            AtomicLocalRebalancingBridge
                .InsufficientOutputTokenProduced
                .selector
        );
        localBridge.rebalance(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(source)),
            _toBytes32(address(destination)),
            abi.encode(calls)
        );
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
        _localRebalance(100e6, calls);
    }

    function test_transferRemote_revertsWhenCallsDrainSourceWithLeakedApproval()
        public
    {
        swapTarget.setOutputAmount(100e6);
        sourceRouter.setPostCallbackApproval(1e6);

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
        vm.expectRevert(
            AtomicLocalRebalancingBridge.SourceRouterOverdrawn.selector
        );
        _localRebalance(100e6, calls);
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
        _localRebalance(100e6, calls);
    }

    function test_rebalance_revertsOnDelegatecall() public {
        // A delegatecall runs in the bridge's storage context and could re-arm
        // the transient callback slot to pull the source router again
        // (HL-2026Q3-003); safeMulticall rejects it before it executes.
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            address(swapTarget),
            CallLib.DELEGATECALL_SENTINEL,
            abi.encodeCall(TestSwapTarget.swapExactInput, (100e6))
        );

        vm.prank(rebalancer);
        vm.expectRevert(CallLib.DelegatecallNotAllowed.selector);
        _localRebalance(100e6, calls);
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
        _localRebalance(100e6, calls);

        assertEq(inputToken.balanceOf(address(sourceRouter)), 999_901e6);
        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e6);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_rebalance_doesNotDecreaseRouterTokenSum(
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
                address(sourceRouter),
                bridgeOwner
            );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));
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
        try
            localBridge.rebalance(
                LOCAL_DOMAIN,
                amountIn,
                ITokenBridge(address(sourceRouter)),
                _toBytes32(address(destinationRouter)),
                abi.encode(calls)
            )
        {
            assertGe(
                sharedToken.balanceOf(address(sourceRouter)) +
                    sharedToken.balanceOf(address(destinationRouter)) +
                    sharedToken.balanceOf(address(unrelatedRouter)),
                routerSumBefore
            );
        } catch {}
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_rebalance_crossDecimalPreservesValue(
        uint256 rawAmountIn,
        uint8 inDecRaw,
        uint8 outDecRaw,
        uint256 rawSwapOut
    ) public {
        uint8 inDec = uint8(bound(inDecRaw, 2, 18));
        uint8 outDec = uint8(bound(outDecRaw, 2, 18));

        ERC20Test inTok = new ERC20Test("In", "IN", 0, inDec);
        ERC20Test outTok = new ERC20Test("Out", "OUT", 0, outDec);
        MockRebalanceRouter src = new MockRebalanceRouter(
            inTok,
            LOCAL_DOMAIN,
            1,
            1
        );
        MockRebalanceRouter dst = new MockRebalanceRouter(
            outTok,
            LOCAL_DOMAIN,
            1,
            1
        );
        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(src),
                bridgeOwner
            );
        src.setPrimaryRouter(LOCAL_DOMAIN, address(dst));
        src.setCallbackRecipient(address(dst));
        src.addRebalancer(rebalancer);
        src.addRebalancer(address(localBridge));

        uint256 amountIn = bound(rawAmountIn, 1, 1_000 * (10 ** inDec));
        inTok.mintTo(address(src), 1_000_000 * (10 ** inDec));

        // The bridge converts by decimals (rounding up), so bound the swap
        // output at or above requiredOutputAmount to keep the rebalance succeeding and
        // assert the invariant on every run (no swallowed reverts).
        uint256 requiredOutputAmount = Math.mulDiv(
            amountIn,
            10 ** outDec,
            10 ** inDec,
            Math.Rounding.Up
        );
        uint256 swapOut = bound(
            rawSwapOut,
            requiredOutputAmount,
            requiredOutputAmount + 1_000 * (10 ** outDec)
        );

        TestSwapTarget swap = new TestSwapTarget(
            address(inTok),
            address(outTok)
        );
        swap.setOutputAmount(swapOut);
        outTok.mintTo(address(swap), type(uint128).max);

        CallLib.Call[] memory calls = new CallLib.Call[](2);
        calls[0] = CallLib.build(
            address(inTok),
            0,
            abi.encodeCall(IERC20.approve, (address(swap), amountIn))
        );
        calls[1] = CallLib.build(
            address(swap),
            0,
            abi.encodeCall(TestSwapTarget.swapExactInput, (amountIn))
        );

        uint256 valueBefore = inTok.balanceOf(address(src)) *
            (10 ** (36 - inDec)) +
            outTok.balanceOf(address(dst)) *
            (10 ** (36 - outDec));

        vm.prank(rebalancer);
        localBridge.rebalance(
            LOCAL_DOMAIN,
            amountIn,
            ITokenBridge(address(src)),
            _toBytes32(address(dst)),
            abi.encode(calls)
        );

        uint256 valueAfter = inTok.balanceOf(address(src)) *
            (10 ** (36 - inDec)) +
            outTok.balanceOf(address(dst)) *
            (10 ** (36 - outDec));

        // Decimal-normalized router value must not decrease, and may only
        // increase by the sub-unit up-rounding of requiredOutputAmount.
        assertGe(valueAfter, valueBefore);
        assertLt(valueAfter - valueBefore, 10 ** (36 - outDec));
    }

    function test_rebalance_usesDecimalNormalizedRequiredOutputAmount() public {
        outputToken = new ERC20Test("Output18", "OUT18", 0, 18);
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        swapTarget.setOutputAmount(100e18);

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(outputToken.balanceOf(address(destinationRouter)), 100e18);
    }

    function test_rebalance_revertsWhenBelowDecimalNormalizedRequiredOutputAmount()
        public
    {
        outputToken = new ERC20Test("Output18", "OUT18", 0, 18);
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge
                .InsufficientOutputTokenProduced
                .selector
        );
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_rebalance_revertsForInvalidOutputToken() public {
        destinationRouter = new MockRebalanceRouter(
            ERC20Test(address(0)),
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));
        sourceRouter.setCallbackRecipient(address(destinationRouter));

        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidToken.selector);
        _localRebalance(100e6, noCalls);
    }

    function test_quoteTransferRemote_revertsForNativeCallerToken() public {
        MockRebalanceRouter nativeCaller = new MockRebalanceRouter(
            ERC20Test(address(0)),
            LOCAL_DOMAIN,
            1,
            1
        );

        vm.prank(address(nativeCaller));
        vm.expectRevert(AtomicLocalRebalancingBridge.InvalidToken.selector);
        bridge.quoteTransferRemote(LOCAL_DOMAIN, bytes32(0), 100e6);
    }

    function test_rebalance_allowsDecimalNormalizedRequiredOutputAmountDown()
        public
    {
        inputToken = new ERC20Test("Input18", "IN18", 0, 18);
        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(sourceRouter),
                bridgeOwner
            );
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));
        sourceRouter.setCallbackRecipient(address(destinationRouter));
        inputToken.mintTo(address(sourceRouter), 1_000_000e18);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(localBridge));
        swapTarget = new TestSwapTarget(
            address(inputToken),
            address(outputToken)
        );
        outputToken.mintTo(address(swapTarget), type(uint128).max);
        swapTarget.setOutputAmount(90e6);

        vm.prank(rebalancer);
        localBridge.rebalance(
            LOCAL_DOMAIN,
            90e18,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(destinationRouter)),
            abi.encode(_rebalancerCalls(90e18))
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 90e6);
    }

    function test_rebalance_roundsRequiredOutputAmountUp() public {
        inputToken = new ERC20Test("Input18", "IN18", 0, 18);
        sourceRouter = new MockRebalanceRouter(inputToken, LOCAL_DOMAIN, 1, 1);
        AtomicLocalRebalancingBridge localBridge = new AtomicLocalRebalancingBridge(
                LOCAL_DOMAIN,
                address(sourceRouter),
                bridgeOwner
            );
        destinationRouter = new MockRebalanceRouter(
            outputToken,
            LOCAL_DOMAIN,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));
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
        localBridge.rebalance(
            LOCAL_DOMAIN,
            1e12 + 1,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(destinationRouter)),
            abi.encode(_rebalancerCalls(1e12 + 1))
        );

        assertEq(outputToken.balanceOf(address(destinationRouter)), 2);
    }

    function test_transferRemote_revertsWhenRebalancerCallReverts() public {
        swapTarget.setShouldRevert(true);
        vm.prank(rebalancer);
        vm.expectRevert("TestSwapTarget: revert");
        _localRebalance(100e6, _rebalancerCalls(100e6));
    }

    function test_transferRemote_revertsIfOutputNotApproved() public {
        swapTarget.setOutputAmount(100e6);
        outputToken.mintTo(rebalancer, 1e6);

        vm.prank(rebalancer);
        vm.expectRevert("ERC20: insufficient allowance");
        _localRebalance(100e6, _rebalancerCallsWithTopUp(100e6, 1e6));
    }

    function test_transferRemote_revertsIfNoOutput() public {
        outputToken.mintTo(rebalancer, 100e6);

        CallLib.Call[] memory noCalls = new CallLib.Call[](0);

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge
                .InsufficientOutputTokenProduced
                .selector
        );
        _localRebalance(100e6, noCalls);
    }

    function test_transferRemote_keepsBridgeBalancesFlat() public {
        swapTarget.setOutputAmount(100e6);

        vm.prank(rebalancer);
        _localRebalance(100e6, _rebalancerCalls(100e6));

        assertEq(inputToken.balanceOf(address(bridge)), 0);
        assertEq(outputToken.balanceOf(address(bridge)), 0);
    }

    function test_rebalance_usesCrossCollateralEnrollmentPath() public {
        swapTarget.setOutputAmount(100e6);
        // altDestinationRouter is enrolled as a cross-collateral target (not the
        // primary router), exercising the non-canonical isRebalanceTarget path.
        sourceRouter.setCallbackRecipient(address(altDestinationRouter));

        vm.prank(rebalancer);
        bridge.rebalance(
            LOCAL_DOMAIN,
            100e6,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(altDestinationRouter)),
            abi.encode(_rebalancerCalls(100e6))
        );

        assertEq(outputToken.balanceOf(address(altDestinationRouter)), 100e6);
    }

    function _localRebalance(
        uint256 amountIn,
        CallLib.Call[] memory calls
    ) internal {
        bridge.rebalance(
            LOCAL_DOMAIN,
            amountIn,
            ITokenBridge(address(sourceRouter)),
            _toBytes32(address(destinationRouter)),
            abi.encode(calls)
        );
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
