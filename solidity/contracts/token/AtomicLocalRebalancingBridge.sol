// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, ITokenFee, Quote} from "../interfaces/ITokenBridge.sol";
import {TransientStorage} from "../libs/TransientStorage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Optional invariant enforced after rebalancer calls complete.
/// @dev `RequiredDelta` checks destination balance delta against `amountIn`.
enum CallInvariant {
    None,
    RequiredDelta
}

/// @title AtomicLocalRebalancingBridge
/// @notice Same-chain `ITokenBridge` rebalancer wrapper for atomic local rebalances.
/// @dev The wrapper must be configured as an allowed rebalancer/bridge on the
/// source router. The source router is treated as the trust boundary.
contract AtomicLocalRebalancingBridge is ITokenBridge, PackageVersioned {
    using SafeERC20 for IERC20;
    using TransientStorage for bytes32;

    bytes32 private constant _CALLBACK_RECIPIENT_SLOT =
        keccak256("hyperlane.atomicLocalRebalancingBridge.callbackRecipient");

    uint32 public immutable localDomain;
    CallInvariant public immutable callInvariant;

    error RebalanceAlreadyActive();
    error NoActiveRebalance();
    error InvalidCallback();
    error InsufficientOutput();
    error UnauthorizedRebalancer();

    constructor(uint32 _localDomain, CallInvariant _callInvariant) {
        localDomain = _localDomain;
        callInvariant = _callInvariant;
    }

    /// @notice Executes a same-chain rebalance into an enrolled destination
    /// router.
    /// @dev `calls` run after source collateral has been pulled into this
    /// wrapper. Use calls for token approvals, DEX swaps, and paying the
    /// destination router.
    function localRebalance(
        address sourceRouter,
        uint256 amountIn,
        CallLib.Call[] calldata calls
    ) external payable {
        if (_CALLBACK_RECIPIENT_SLOT.loadBytes32() != bytes32(0))
            revert RebalanceAlreadyActive();

        MovableCollateralRouter source = MovableCollateralRouter(sourceRouter);
        if (!_isAllowedRebalancer(source, msg.sender))
            revert UnauthorizedRebalancer();

        _CALLBACK_RECIPIENT_SLOT.store(
            TypeCasts.addressToBytes32(sourceRouter)
        );

        // Enters this contract via transferRemote, which escrows source funds
        // and writes the destination recipient into transient storage.
        source.rebalance(localDomain, amountIn, this);
        bytes32 recipient = _CALLBACK_RECIPIENT_SLOT.loadBytes32();
        _CALLBACK_RECIPIENT_SLOT.clear();

        if (callInvariant == CallInvariant.None) {
            CallLib.multicallCalldata(calls);
            return;
        }

        address destinationRouter = TypeCasts.bytes32ToAddress(recipient);

        IERC20 token = IERC20(
            MovableCollateralRouter(destinationRouter).token()
        );
        uint256 balanceBefore = token.balanceOf(destinationRouter);

        CallLib.multicallCalldata(calls);

        uint256 delta = token.balanceOf(destinationRouter) - balanceBefore;
        if (delta < amountIn) revert InsufficientOutput();
    }

    /// @notice Callback quote used by `MovableCollateralRouter.rebalance`.
    function quoteTransferRemote(
        uint32 destination,
        bytes32,
        uint256 amount
    ) external view override(ITokenFee) returns (Quote[] memory quotes) {
        if (destination != localDomain) revert InvalidCallback();
        address inputToken = MovableCollateralRouter(msg.sender).token();

        // Match router rebalance quote semantics: no native fee, exact source
        // token amount pulled by transferRemote, no additional token fee.
        quotes = new Quote[](3);
        quotes[0] = Quote({token: address(0), amount: 0});
        quotes[1] = Quote({token: inputToken, amount: amount});
        quotes[2] = Quote({token: inputToken, amount: 0});
    }

    /// @notice Router callback. Pulls input into escrow for the active local
    /// rebalance.
    function transferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) external payable override returns (bytes32) {
        bytes32 activeSourceRouter = _CALLBACK_RECIPIENT_SLOT.loadBytes32();
        if (activeSourceRouter == bytes32(0)) revert NoActiveRebalance();
        if (destination != localDomain) revert InvalidCallback();
        if (TypeCasts.bytes32ToAddress(activeSourceRouter) != msg.sender)
            revert InvalidCallback();
        IERC20(MovableCollateralRouter(msg.sender).token()).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );
        // Captured for localRebalance to resolve the destination router after
        // the source router finishes its rebalance flow.
        _CALLBACK_RECIPIENT_SLOT.store(recipient);
        return bytes32(0);
    }

    function _isAllowedRebalancer(
        MovableCollateralRouter source,
        address rebalancer
    ) internal view returns (bool) {
        address[] memory allowedRebalancers = source.allowedRebalancers();
        uint256 length = allowedRebalancers.length;
        for (uint256 i = 0; i < length; ++i) {
            if (allowedRebalancers[i] == rebalancer) return true;
        }
        return false;
    }
}
