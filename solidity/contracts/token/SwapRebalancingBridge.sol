// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, ITokenFee, Quote} from "../interfaces/ITokenBridge.sol";
import {ISwapRebalancingBridge, SwapCall, PendingRebalance} from "./interfaces/ISwapRebalancingBridge.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

interface IMovableCollateralRouterLike {
    function rebalance(
        uint32 domain,
        uint256 collateralAmount,
        ITokenBridge bridge
    ) external payable;

    function token() external view returns (address);

    function localDomain() external view returns (uint32);

    function routers(uint32 domain) external view returns (bytes32);

    function scaleNumerator() external view returns (uint256);

    function scaleDenominator() external view returns (uint256);
}

interface ICrossCollateralRouterLike is IMovableCollateralRouterLike {
    function crossCollateralRouters(
        uint32 domain,
        bytes32 router
    ) external view returns (bool);
}

/// @title SwapRebalancingBridge
/// @notice Same-chain `ITokenBridge` used by `MovableCollateralRouter` to pull
/// source collateral, execute exact-input swap calls, and fund an enrolled
/// destination router with the exact nominal amount implied by router scale
/// math.
/// @dev
/// Intended usage:
/// - owner whitelists authorized rebalancer EOAs, external swap `target`s, and
/// ERC20 `allowanceTarget`s
/// - rebalancer calls `executeRebalance(...)` with source router, intended
/// destination router, `amountIn`, rebalancer stop-loss `minAmountOut`, and
/// exact-input swap calldata
/// - bridge verifies the destination router is enrolled on the source router
/// via `routers(...)` or `crossCollateralRouters(...)`
/// - bridge stores pending state, calls
/// `sourceRouter.rebalance(localDomain, amountIn, this)`, receives the router
/// callback, executes swap calls, tops up any output shortfall from the
/// rebalancer in `outputToken`, transfers exactly `requiredOut` to the
/// destination router, and refunds any surplus to the rebalancer
///
/// Accepted tradeoffs:
/// - same-chain only
/// - one in-flight rebalance per bridge
/// - intended for exact-input router-style swaps where the external venue owns
/// the hop path; not a fully generic multi-step token executor
/// - computes nominal output using standard `TokenRouter`
/// `scaleNumerator/scaleDenominator`; routers with custom inbound/outbound math
/// need a different adapter design
/// - ignores callback `recipient`; the rebalancer-supplied enrolled
/// `destinationRouter` is authoritative
///
/// Ergonomics:
/// - single-call entrypoint for the rebalancer
/// - owner-managed allowlists bind arbitrary calldata to known swap venues
/// - helper views expose destination enrollment and nominal amount calculations
/// for offchain planning
///
/// Trust assumptions:
/// - owner maintains a safe allowlist of swap venues and spenders
/// - authorized rebalancers choose economically sane calldata and can fund
/// output-token shortfalls
/// - source router is configured to allow `rebalance(localDomain, amountIn,
/// bridge)` to succeed
/// - source and destination routers expose honest token and scale parameters
contract SwapRebalancingBridge is
    ITokenBridge,
    ISwapRebalancingBridge,
    Ownable,
    PackageVersioned
{
    using SafeERC20 for IERC20;
    using Address for address;

    mapping(address => bool) public authorizedRebalancers;
    mapping(address => bool) public whitelistedTargets;
    mapping(address => bool) public whitelistedAllowanceTargets;

    PendingRebalance internal pending;
    SwapCall[] internal pendingSwapCalls;

    event RebalancerSet(address indexed rebalancer, bool allowed);
    event TargetSet(address indexed target, bool allowed);
    event AllowanceTargetSet(address indexed target, bool allowed);
    event RebalanceStarted(
        address indexed initiator,
        address indexed sourceRouter,
        address indexed destinationRouter,
        uint256 amountIn,
        uint256 requiredOut,
        uint256 minAmountOut
    );
    event RebalanceExecuted(
        address indexed initiator,
        address indexed sourceRouter,
        address indexed destinationRouter,
        address inputToken,
        address outputToken,
        uint256 amountIn,
        uint256 swapAmountOut,
        uint256 requiredOut,
        uint256 shortfallPulled,
        uint256 surplusRefunded
    );

    error UnauthorizedRebalancer();
    error RebalanceAlreadyPending();
    error NoPendingRebalance();
    error InvalidSourceRouter();
    error InvalidDestinationRouter();
    error DestinationNotEnrolled();
    error InvalidDomain();
    error DeadlineExpired();
    error NativeValueNotAccepted();
    error InvalidCallback();
    error InvalidScale();
    error AmountOutTooLow();
    error InputNotFullySpent();
    error UnapprovedTarget();
    error UnapprovedAllowanceTarget();
    error InsufficientTopUp();

    constructor() Ownable() {}

    /// @notice Adds or removes an authorized rebalancer.
    function setAuthorizedRebalancer(
        address rebalancer,
        bool allowed
    ) external onlyOwner {
        authorizedRebalancers[rebalancer] = allowed;
        emit RebalancerSet(rebalancer, allowed);
    }

    /// @notice Adds or removes a permitted external call target.
    function setTarget(address target, bool allowed) external onlyOwner {
        whitelistedTargets[target] = allowed;
        emit TargetSet(target, allowed);
    }

    /// @notice Adds or removes a permitted ERC20 allowance target.
    function setAllowanceTarget(
        address target,
        bool allowed
    ) external onlyOwner {
        whitelistedAllowanceTargets[target] = allowed;
        emit AllowanceTargetSet(target, allowed);
    }

    /// @notice Returns the current in-flight rebalance, if any.
    function pendingRebalance()
        external
        view
        returns (PendingRebalance memory)
    {
        return pending;
    }

    /// @notice Returns whether `destinationRouter` is enrolled on
    /// `sourceRouter` for the source router's local domain.
    function isEnrolledDestination(
        address sourceRouter,
        address destinationRouter
    ) external view returns (bool) {
        return
            _isEnrolledDestination(
                sourceRouter,
                destinationRouter,
                IMovableCollateralRouterLike(sourceRouter).localDomain()
            );
    }

    /// @notice Returns the nominal destination amount implied by standard
    /// router scale math.
    function requiredOut(
        address sourceRouter,
        address destinationRouter,
        uint256 amountIn
    ) external view returns (uint256) {
        return
            _requiredOut(
                IMovableCollateralRouterLike(sourceRouter),
                IMovableCollateralRouterLike(destinationRouter),
                amountIn
            );
    }

    /// @notice Starts a same-chain rebalance into an enrolled destination
    /// router.
    /// @dev
    /// `minAmountOut` is the rebalancer's stop-loss threshold. LP protection is
    /// enforced separately by requiring the destination router to receive
    /// exactly `requiredOut`.
    function executeRebalance(
        address sourceRouter,
        address destinationRouter,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        SwapCall[] calldata swapCalls
    ) external {
        if (!authorizedRebalancers[msg.sender]) revert UnauthorizedRebalancer();
        if (pending.sourceRouter != address(0))
            revert RebalanceAlreadyPending();
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (sourceRouter == address(0) || !sourceRouter.isContract()) {
            revert InvalidSourceRouter();
        }
        if (
            destinationRouter == address(0) || !destinationRouter.isContract()
        ) {
            revert InvalidDestinationRouter();
        }

        IMovableCollateralRouterLike source = IMovableCollateralRouterLike(
            sourceRouter
        );
        IMovableCollateralRouterLike destination = IMovableCollateralRouterLike(
            destinationRouter
        );

        uint32 localDomain = source.localDomain();
        if (localDomain != destination.localDomain()) revert InvalidDomain();
        if (
            !_isEnrolledDestination(
                sourceRouter,
                destinationRouter,
                localDomain
            )
        ) {
            revert DestinationNotEnrolled();
        }

        address inputToken = source.token();
        address outputToken = destination.token();
        if (inputToken == address(0) || outputToken == address(0)) {
            revert InvalidSourceRouter();
        }

        pending = PendingRebalance({
            initiator: msg.sender,
            sourceRouter: sourceRouter,
            destinationRouter: destinationRouter,
            inputToken: inputToken,
            outputToken: outputToken,
            localDomain: localDomain,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            requiredOut: _requiredOut(source, destination, amountIn),
            deadline: deadline
        });
        _storeSwapCalls(swapCalls);

        emit RebalanceStarted(
            msg.sender,
            sourceRouter,
            destinationRouter,
            amountIn,
            pending.requiredOut,
            minAmountOut
        );

        source.rebalance(localDomain, amountIn, this);
    }

    /// @notice Callback quote used by `MovableCollateralRouter.rebalance`.
    /// @dev Returns only the source-token pull quote. The callback `recipient`
    /// is ignored because the bridge uses pending state to choose the actual
    /// destination router.
    function quoteTransferRemote(
        uint32 destination,
        bytes32,
        uint256 amount
    )
        external
        view
        override(ITokenFee, ISwapRebalancingBridge)
        returns (Quote[] memory quotes)
    {
        if (pending.sourceRouter == address(0)) revert NoPendingRebalance();
        if (destination != pending.localDomain || amount != pending.amountIn) {
            revert InvalidCallback();
        }

        quotes = new Quote[](3);
        quotes[0] = Quote({token: address(0), amount: 0});
        quotes[1] = Quote({
            token: pending.inputToken,
            amount: pending.amountIn
        });
        quotes[2] = Quote({token: pending.inputToken, amount: 0});
    }

    /// @notice Pulls source collateral from the source router, executes swap
    /// calls, and settles the destination router exactly.
    /// @dev
    /// If the swap under-delivers, the bridge pulls the shortfall from the
    /// rebalancer in `outputToken`. If the swap over-delivers, the bridge
    /// refunds the surplus to the rebalancer.
    function transferRemote(
        uint32 destination,
        bytes32,
        uint256 amount
    ) external payable override returns (bytes32) {
        if (pending.sourceRouter == address(0)) revert NoPendingRebalance();
        if (msg.sender != pending.sourceRouter) revert InvalidCallback();
        if (msg.value != 0) revert NativeValueNotAccepted();
        if (destination != pending.localDomain || amount != pending.amountIn) {
            revert InvalidCallback();
        }

        IERC20 inputToken = IERC20(pending.inputToken);
        IERC20 outputToken = IERC20(pending.outputToken);

        uint256 outputBefore = outputToken.balanceOf(address(this));
        inputToken.safeTransferFrom(
            msg.sender,
            address(this),
            pending.amountIn
        );
        _executeSwapCalls();
        if (
            pending.inputToken != pending.outputToken &&
            inputToken.balanceOf(address(this)) != 0
        ) revert InputNotFullySpent();
        // When input and output token are the same, any unspent input is part
        // of `actualOut` and is later refunded to the rebalancer as surplus.
        uint256 outputAfter = outputToken.balanceOf(address(this));
        uint256 actualOut = outputAfter - outputBefore;

        if (actualOut < pending.minAmountOut) revert AmountOutTooLow();

        PendingRebalance memory current = pending;
        _clearPending();

        uint256 shortfallPulled = 0;
        if (actualOut < current.requiredOut) {
            shortfallPulled = current.requiredOut - actualOut;
            outputToken.safeTransferFrom(
                current.initiator,
                address(this),
                shortfallPulled
            );
            if (
                outputToken.balanceOf(address(this)) <
                outputBefore + current.requiredOut
            ) revert InsufficientTopUp();
        }

        outputToken.safeTransfer(
            current.destinationRouter,
            current.requiredOut
        );

        uint256 surplusRefunded = 0;
        uint256 remainingOutput = outputToken.balanceOf(address(this)) -
            outputBefore;
        if (remainingOutput > 0) {
            surplusRefunded = remainingOutput;
            outputToken.safeTransfer(current.initiator, surplusRefunded);
        }

        emit RebalanceExecuted(
            current.initiator,
            current.sourceRouter,
            current.destinationRouter,
            current.inputToken,
            current.outputToken,
            current.amountIn,
            actualOut,
            current.requiredOut,
            shortfallPulled,
            surplusRefunded
        );
        return bytes32(0);
    }

    /// @dev Checks destination enrollment against the source router's local
    /// router mapping or cross-collateral enrollment set.
    function _isEnrolledDestination(
        address sourceRouter,
        address destinationRouter,
        uint32 localDomain
    ) internal view returns (bool) {
        bytes32 encoded = bytes32(uint256(uint160(destinationRouter)));
        if (
            IMovableCollateralRouterLike(sourceRouter).routers(localDomain) ==
            encoded
        ) {
            return true;
        }

        try
            ICrossCollateralRouterLike(sourceRouter).crossCollateralRouters(
                localDomain,
                encoded
            )
        returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @dev Computes the destination router's nominal credit using standard
    /// `TokenRouter` scale math.
    function _requiredOut(
        IMovableCollateralRouterLike sourceRouter,
        IMovableCollateralRouterLike destinationRouter,
        uint256 amountIn
    ) internal view returns (uint256) {
        uint256 sourceScaleNumerator = sourceRouter.scaleNumerator();
        uint256 sourceScaleDenominator = sourceRouter.scaleDenominator();
        uint256 destinationScaleNumerator = destinationRouter.scaleNumerator();
        uint256 destinationScaleDenominator = destinationRouter
            .scaleDenominator();

        if (
            sourceScaleNumerator == 0 ||
            sourceScaleDenominator == 0 ||
            destinationScaleNumerator == 0 ||
            destinationScaleDenominator == 0
        ) revert InvalidScale();

        uint256 canonical = Math.mulDiv(
            amountIn,
            sourceScaleNumerator,
            sourceScaleDenominator,
            Math.Rounding.Down
        );

        return
            Math.mulDiv(
                canonical,
                destinationScaleDenominator,
                destinationScaleNumerator,
                Math.Rounding.Down
            );
    }

    /// @dev Copies calldata swap steps into storage for the router callback.
    function _storeSwapCalls(SwapCall[] calldata swapCalls) internal {
        delete pendingSwapCalls;
        uint256 length = swapCalls.length;
        for (uint256 i = 0; i < length; ++i) {
            pendingSwapCalls.push(
                SwapCall({
                    target: swapCalls[i].target,
                    allowanceTarget: swapCalls[i].allowanceTarget,
                    data: swapCalls[i].data
                })
            );
        }
    }

    /// @dev Executes whitelisted swap calls with temporary exact-input
    /// approvals.
    function _executeSwapCalls() internal {
        IERC20 inputToken = IERC20(pending.inputToken);
        uint256 length = pendingSwapCalls.length;

        for (uint256 i = 0; i < length; ++i) {
            SwapCall storage swapCall = pendingSwapCalls[i];
            if (!whitelistedTargets[swapCall.target]) revert UnapprovedTarget();
            if (
                swapCall.allowanceTarget != address(0) &&
                !whitelistedAllowanceTargets[swapCall.allowanceTarget]
            ) revert UnapprovedAllowanceTarget();

            if (swapCall.allowanceTarget != address(0)) {
                if (inputToken.balanceOf(address(this)) > 0) {
                    inputToken.forceApprove(
                        swapCall.allowanceTarget,
                        pending.amountIn
                    );
                }
            }

            (bool success, bytes memory returnData) = swapCall.target.call(
                swapCall.data
            );

            if (swapCall.allowanceTarget != address(0)) {
                inputToken.forceApprove(swapCall.allowanceTarget, 0);
            }

            if (!success) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
        }
    }

    function _clearPending() internal {
        delete pending;
        delete pendingSwapCalls;
    }
}
