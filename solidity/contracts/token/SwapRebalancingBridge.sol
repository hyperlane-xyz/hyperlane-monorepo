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
    error AmountOutTooLow();
    error InputNotFullySpent();
    error UnapprovedTarget();
    error UnapprovedAllowanceTarget();
    error InsufficientTopUp();

    constructor() Ownable() {}

    function setAuthorizedRebalancer(
        address rebalancer,
        bool allowed
    ) external onlyOwner {
        authorizedRebalancers[rebalancer] = allowed;
        emit RebalancerSet(rebalancer, allowed);
    }

    function setTarget(address target, bool allowed) external onlyOwner {
        whitelistedTargets[target] = allowed;
        emit TargetSet(target, allowed);
    }

    function setAllowanceTarget(
        address target,
        bool allowed
    ) external onlyOwner {
        whitelistedAllowanceTargets[target] = allowed;
        emit AllowanceTargetSet(target, allowed);
    }

    function pendingRebalance()
        external
        view
        returns (PendingRebalance memory)
    {
        return pending;
    }

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

    function executeRebalance(
        address sourceRouter,
        address destinationRouter,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        SwapCall[] calldata swapCalls
    ) external payable {
        if (!authorizedRebalancers[msg.sender]) revert UnauthorizedRebalancer();
        if (msg.value != 0) revert NativeValueNotAccepted();
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

    function _requiredOut(
        IMovableCollateralRouterLike sourceRouter,
        IMovableCollateralRouterLike destinationRouter,
        uint256 amountIn
    ) internal view returns (uint256) {
        uint256 canonical = Math.mulDiv(
            amountIn,
            sourceRouter.scaleNumerator(),
            sourceRouter.scaleDenominator(),
            Math.Rounding.Down
        );

        return
            Math.mulDiv(
                canonical,
                destinationRouter.scaleDenominator(),
                destinationRouter.scaleNumerator(),
                Math.Rounding.Down
            );
    }

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

    function _executeSwapCalls() internal {
        IERC20 inputToken = IERC20(pending.inputToken);
        IERC20 outputToken = IERC20(pending.outputToken);
        uint256 length = pendingSwapCalls.length;

        for (uint256 i = 0; i < length; ++i) {
            SwapCall storage swapCall = pendingSwapCalls[i];
            if (!whitelistedTargets[swapCall.target]) revert UnapprovedTarget();
            if (
                swapCall.allowanceTarget != address(0) &&
                !whitelistedAllowanceTargets[swapCall.allowanceTarget]
            ) revert UnapprovedAllowanceTarget();

            if (swapCall.allowanceTarget != address(0)) {
                uint256 inputBalance = inputToken.balanceOf(address(this));
                if (inputBalance > 0) {
                    inputToken.forceApprove(
                        swapCall.allowanceTarget,
                        inputBalance
                    );
                }

                if (pending.outputToken != pending.inputToken) {
                    uint256 outputBalance = outputToken.balanceOf(
                        address(this)
                    );
                    if (outputBalance > 0) {
                        outputToken.forceApprove(
                            swapCall.allowanceTarget,
                            outputBalance
                        );
                    }
                }
            }

            (bool success, bytes memory returnData) = swapCall.target.call(
                swapCall.data
            );

            if (swapCall.allowanceTarget != address(0)) {
                inputToken.forceApprove(swapCall.allowanceTarget, 0);
                if (pending.outputToken != pending.inputToken) {
                    outputToken.forceApprove(swapCall.allowanceTarget, 0);
                }
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
