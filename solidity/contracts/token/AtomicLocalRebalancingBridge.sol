// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, ITokenFee, Quote} from "../interfaces/ITokenBridge.sol";
import {TransientStorage} from "../libs/TransientStorage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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

    error RebalanceAlreadyActive();
    error NoActiveRebalance();
    error InvalidCallback();
    error InsufficientOutput();
    error InvalidInputDelta();
    error UnauthorizedRebalancer();
    error InvalidToken();

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
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
        if (_CALLBACK_RECIPIENT_SLOT.loadBytes32() != bytes32(0)) {
            revert RebalanceAlreadyActive();
        }

        MovableCollateralRouter source = MovableCollateralRouter(sourceRouter);
        if (!source.isAllowedRebalancer(msg.sender)) {
            revert UnauthorizedRebalancer();
        }

        address inputToken = source.token();
        if (inputToken == address(0)) revert InvalidToken();
        uint256 sourceBalanceBefore = IERC20(inputToken).balanceOf(
            sourceRouter
        );

        address destinationRouter = _rebalanceSource(
            source,
            sourceRouter,
            amountIn
        );
        address outputToken = MovableCollateralRouter(destinationRouter)
            .token();
        if (outputToken == address(0)) revert InvalidToken();
        uint256 requiredDelta = _requiredDelta(
            inputToken,
            outputToken,
            amountIn
        );
        uint256 destinationBalanceBefore = IERC20(outputToken).balanceOf(
            destinationRouter
        );
        CallLib.multicallCalldata(calls);

        // Source may be topped up, but calls must not drain more than amountIn.
        if (
            IERC20(inputToken).balanceOf(sourceRouter) <
            sourceBalanceBefore - amountIn
        ) {
            revert InvalidInputDelta();
        }
        if (
            IERC20(outputToken).balanceOf(destinationRouter) <
            destinationBalanceBefore + requiredDelta
        ) {
            revert InsufficientOutput();
        }
        // Keep the wrapper stateless for exact-output and variable-output paths.
        _refundTokenBalance(inputToken, msg.sender);
        if (outputToken != inputToken) {
            _refundTokenBalance(outputToken, msg.sender);
        }
    }

    function _rebalanceSource(
        MovableCollateralRouter source,
        address sourceRouter,
        uint256 amountIn
    ) internal returns (address destinationRouter) {
        _CALLBACK_RECIPIENT_SLOT.store(
            TypeCasts.addressToBytes32(sourceRouter)
        );

        // Enters this contract via transferRemote, which escrows source funds
        // and writes the destination recipient into transient storage.
        source.rebalance(localDomain, amountIn, this);
        destinationRouter = TypeCasts.bytes32ToAddress(
            _CALLBACK_RECIPIENT_SLOT.loadBytes32()
        );
        _CALLBACK_RECIPIENT_SLOT.clear();
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
        if (TypeCasts.bytes32ToAddress(activeSourceRouter) != msg.sender) {
            revert InvalidCallback();
        }
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

    function _requiredDelta(
        address inputToken,
        address outputToken,
        uint256 amountIn
    ) internal view returns (uint256 requiredDelta) {
        uint256 inputScale = _decimalScale(inputToken);
        uint256 outputScale = _decimalScale(outputToken);
        if (inputScale == outputScale) return amountIn;
        // Round up so decimal conversion never underfunds the destination.
        return Math.mulDiv(amountIn, outputScale, inputScale, Math.Rounding.Up);
    }

    function _decimalScale(address token) internal view returns (uint256) {
        return 10 ** uint256(IERC20Metadata(token).decimals());
    }

    function _refundTokenBalance(address token, address recipient) internal {
        uint256 refund = IERC20(token).balanceOf(address(this));
        if (refund > 0) IERC20(token).safeTransfer(recipient, refund);
    }
}
