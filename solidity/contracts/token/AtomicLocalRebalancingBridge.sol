// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, ITokenFee, Quote} from "../interfaces/ITokenBridge.sol";
import {TransientStorage} from "../libs/TransientStorage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";
import {IRebalanceTargets} from "./interfaces/IRebalanceTargets.sol";

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

    // Stores the active source router during `rebalance` so the source router
    // callback (`transferRemote`) can authenticate itself.
    bytes32 private constant _ACTIVE_SOURCE_SLOT =
        keccak256("hyperlane.atomicLocalRebalancingBridge.activeSource");

    uint32 public immutable localDomain;

    error RebalanceAlreadyActive();
    error NoActiveRebalance();
    error InvalidCallback();
    error InsufficientOutput();
    error InvalidInputDelta();
    error UnauthorizedRebalancer();
    error InvalidRecipient();
    error InvalidToken();
    error NativeRefundFailed();

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    /// @notice Executes a same-chain rebalance into an allowed destination
    /// router.
    /// @dev Mirrors the canonical `MovableCollateralRouter.rebalance` first three
    /// parameters, appending the destination recipient and a catch-all `data`
    /// argument for forward-compatible extensions. For this bridge, `data` is the
    /// abi-encoded `CallLib.Call[]` to run after source collateral is escrowed.
    /// @param domain Must equal `localDomain`; this bridge only rebalances locally.
    /// @param collateralAmount The source collateral amount to rebalance.
    /// @param sourceRouter The source collateral router to pull from. Must allow
    /// this wrapper as a rebalancer/bridge and `msg.sender` as a rebalancer.
    /// @param destinationRecipient The destination collateral router to fund.
    /// Must be an allowed rebalance target on the source router (its enrolled
    /// remote router for `localDomain` or an explicitly allowed rebalance target).
    /// @param data Abi-encoded `CallLib.Call[]`. Use calls for token approvals and
    /// DEX swaps. Calls must leave enough output token on this wrapper for it to
    /// pay the destination router.
    function rebalance(
        uint32 domain,
        uint256 collateralAmount,
        ITokenBridge sourceRouter,
        bytes32 destinationRecipient,
        bytes calldata data
    ) external payable {
        if (domain != localDomain) revert InvalidCallback();
        if (_ACTIVE_SOURCE_SLOT.loadBytes32() != bytes32(0)) {
            revert RebalanceAlreadyActive();
        }

        MovableCollateralRouter source = MovableCollateralRouter(
            address(sourceRouter)
        );
        if (!source.isAllowedRebalancer(msg.sender)) {
            revert UnauthorizedRebalancer();
        }

        address inputToken = source.token();
        if (inputToken == address(0)) revert InvalidToken();
        uint256 sourceBalanceBefore = IERC20(inputToken).balanceOf(
            address(source)
        );

        address destinationRouter = _resolveDestination(
            source,
            destinationRecipient
        );
        address outputToken = MovableCollateralRouter(destinationRouter)
            .token();
        if (outputToken == address(0)) revert InvalidToken();
        uint256 requiredDelta = _requiredDelta(
            inputToken,
            outputToken,
            collateralAmount
        );
        uint256 destinationBalanceBefore = IERC20(outputToken).balanceOf(
            destinationRouter
        );

        // --- Flow of funds ---
        // 1. Escrow: pull `collateralAmount` of inputToken from the source into
        //    this wrapper via the source's canonical rebalance flow, which calls
        //    back into `transferRemote`. The active-source slot authenticates that
        //    callback and is the only reentrancy guard: a nested `rebalance` reverts
        //    `RebalanceAlreadyActive`. It is deliberately not a full transient lock
        //    over the whole body; the post-call balance invariants below bound what
        //    the rebalancer-supplied calls can do.
        _ACTIVE_SOURCE_SLOT.store(TypeCasts.addressToBytes32(address(source)));
        source.rebalance(localDomain, collateralAmount, this);
        _ACTIVE_SOURCE_SLOT.clear();

        // 2. Swap: run rebalancer-supplied calls (e.g. approve + DEX swap) that
        //    convert the escrowed inputToken into outputToken held by this wrapper.
        CallLib.multicall(abi.decode(data, (CallLib.Call[])));

        // 3. Source invariant: calls may top the source up but must not drain it
        //    by more than the escrowed `collateralAmount`.
        if (
            IERC20(inputToken).balanceOf(address(source)) <
            sourceBalanceBefore - collateralAmount
        ) {
            revert InvalidInputDelta();
        }
        // 4. Fund destination: pay `requiredDelta` of outputToken directly from
        //    this wrapper so calls cannot satisfy the local balance delta by
        //    routing output through the destination router itself.
        if (IERC20(outputToken).balanceOf(address(this)) < requiredDelta) {
            revert InsufficientOutput();
        }
        IERC20(outputToken).safeTransfer(destinationRouter, requiredDelta);
        if (
            IERC20(outputToken).balanceOf(destinationRouter) <
            destinationBalanceBefore + requiredDelta
        ) {
            revert InsufficientOutput();
        }
        // 5. Refund: sweep residual input/output tokens and any native value back
        //    to the rebalancer, keeping the wrapper stateless across calls.
        _refundTokenBalance(inputToken, msg.sender);
        _refundTokenBalance(outputToken, msg.sender);
        _refundNativeBalance(msg.sender);
    }

    /// @dev Authorizes the destination router. The recipient must be an allowed
    /// rebalance target on the source (its enrolled remote router for `localDomain`
    /// or an explicitly allowed cross-collateral target). A target must always be
    /// passed explicitly; there is no implicit default.
    function _resolveDestination(
        MovableCollateralRouter source,
        bytes32 destinationRecipient
    ) internal view returns (address destinationRouter) {
        if (
            !IRebalanceTargets(address(source)).isRebalanceTarget(
                localDomain,
                destinationRecipient
            )
        ) {
            revert InvalidRecipient();
        }
        return TypeCasts.bytes32ToAddress(destinationRecipient);
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
        bytes32,
        uint256 amount
    ) external payable override returns (bytes32) {
        bytes32 activeSourceRouter = _ACTIVE_SOURCE_SLOT.loadBytes32();
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
        return bytes32(0);
    }

    /// @dev Converts `amountIn` from input-token units to output-token units by
    /// decimal scale only. Precondition: input and output are 1:1 in value (same
    /// asset or a pegged pair). It applies no price or router-scale conversion, so
    /// the rebalancer-supplied calls must source any value difference themselves.
    /// Both tokens must implement `decimals()`, and the invariant assumes
    /// standard balance-stable ERC20 behavior: no fee-on-transfer, reflection,
    /// rebasing, or balance-altering hooks. Incompatible assets should be
    /// wrapped or adapted before using this bridge.
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

    /// @dev Reverts if `token` does not implement `IERC20Metadata.decimals()`.
    function _decimalScale(address token) internal view returns (uint256) {
        return 10 ** uint256(IERC20Metadata(token).decimals());
    }

    function _refundTokenBalance(address token, address recipient) internal {
        uint256 refund = IERC20(token).balanceOf(address(this));
        if (refund > 0) IERC20(token).safeTransfer(recipient, refund);
    }

    /// @dev Returns any native value left on the wrapper (e.g. unused msg.value)
    /// to `recipient`. Reverts rather than stranding funds if the transfer fails.
    function _refundNativeBalance(address recipient) internal {
        uint256 refund = address(this).balance;
        if (refund > 0) {
            (bool success, ) = recipient.call{value: refund}("");
            if (!success) revert NativeRefundFailed();
        }
    }
}
