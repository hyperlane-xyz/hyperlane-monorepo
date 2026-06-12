// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, ITokenFee, Quote} from "../interfaces/ITokenBridge.sol";
import {TransientStorage} from "../libs/TransientStorage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {ReentrancyGuardTransient} from "../libs/ReentrancyGuardTransient.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @title AtomicLocalRebalancingBridge
/// @notice Same-chain `ITokenBridge` rebalancer wrapper for atomic local rebalances.
/// @dev The wrapper must be configured as an allowed rebalancer/bridge on the
/// source router. The source router is treated as the trust boundary.
/// @dev The source router's configured local recipient (destination router)
/// MUST hold a token economically at par with the source collateral: output is
/// converted from input by decimals only, so a non-par recipient reverts or
/// demands absurd top-ups. Par is a configuration-only invariant, under the
/// same trust model as cross-collateral routing.
contract AtomicLocalRebalancingBridge is
    ITokenBridge,
    PackageVersioned,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;
    using TransientStorage for bytes32;

    bytes32 private constant _EXPECTED_SOURCE_ROUTER_SLOT =
        keccak256(
            "hyperlane.atomicLocalRebalancingBridge.expectedSourceRouter"
        );
    bytes32 private constant _RESOLVED_DESTINATION_ROUTER_SLOT =
        keccak256(
            "hyperlane.atomicLocalRebalancingBridge.resolvedDestinationRouter"
        );

    uint32 public immutable localDomain;

    /// @notice The source router this bridge rebalances from.
    address public immutable sourceRouter;

    /// @notice Emitted on a successful local rebalance.
    event LocalRebalanceExecuted(
        address indexed destinationRouter,
        uint256 amountIn,
        uint256 requiredDelta
    );

    error NoActiveRebalance();
    error InvalidCallback();
    error MissingCallback();
    error InsufficientOutput();
    error InvalidInputDelta();
    error UnauthorizedRebalancer();
    error InvalidToken();
    error InvalidNativeDelta();

    constructor(uint32 _localDomain, address _sourceRouter) {
        localDomain = _localDomain;
        sourceRouter = _sourceRouter;
        // Native-collateral sources are unsupported (decimal conversion needs an
        // ERC20); reject them up front since the source is bound here.
        if (MovableCollateralRouter(_sourceRouter).token() == address(0)) {
            revert InvalidToken();
        }
    }

    /// @notice Executes a same-chain rebalance into an enrolled destination
    /// router.
    /// @dev `calls` run after source collateral has been pulled into this
    /// wrapper. Use calls for token approvals and DEX swaps. Calls must leave
    /// enough output token on this wrapper for it to pay the destination router.
    function localRebalance(
        uint256 amountIn,
        CallLib.Call[] calldata calls
    ) external payable nonReentrant {
        // Excludes pre-existing native from the refund.
        uint256 nativeBefore = address(this).balance - msg.value;

        MovableCollateralRouter source = MovableCollateralRouter(sourceRouter);
        if (!source.isAllowedRebalancer(msg.sender)) {
            revert UnauthorizedRebalancer();
        }

        address inputToken = source.token();
        if (inputToken == address(0)) revert InvalidToken();
        uint256 sourceBalanceBefore = IERC20(inputToken).balanceOf(
            sourceRouter
        );
        // Snapshot the wrapper's own balance before escrow so donations cannot
        // count toward funding or be swept as a refund.
        uint256 inputSelfBefore = IERC20(inputToken).balanceOf(address(this));

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
        // For a shared input/output token reuse the entry snapshot so escrow
        // counts toward funding; otherwise exclude any output-token donation.
        uint256 outputSelfBefore = outputToken == inputToken
            ? inputSelfBefore
            : IERC20(outputToken).balanceOf(address(this));
        uint256 destinationBalanceBefore = IERC20(outputToken).balanceOf(
            destinationRouter
        );
        CallLib.multicallCalldata(calls);

        if (address(this).balance < nativeBefore) revert InvalidNativeDelta();
        // Source may be topped up, but calls must not drain more than amountIn.
        if (
            IERC20(inputToken).balanceOf(sourceRouter) <
            sourceBalanceBefore - amountIn
        ) {
            revert InvalidInputDelta();
        }
        // Calls must produce at least requiredDelta of new output; donations
        // and escrow already on the wrapper cannot fund the destination.
        if (
            IERC20(outputToken).balanceOf(address(this)) <
            outputSelfBefore + requiredDelta
        ) {
            revert InsufficientOutput();
        }
        IERC20(outputToken).safeTransfer(destinationRouter, requiredDelta);
        if (
            IERC20(outputToken).balanceOf(destinationRouter) <
            destinationBalanceBefore + requiredDelta
        ) {
            revert InsufficientOutput();
        }
        // Refund only balances accrued during this call; never sweep donations.
        _refundDelta(inputToken, inputSelfBefore, msg.sender);
        if (outputToken != inputToken) {
            _refundDelta(outputToken, outputSelfBefore, msg.sender);
        }
        // Refund this call's unspent native.
        uint256 nativeBalance = address(this).balance;
        if (nativeBalance > nativeBefore) {
            Address.sendValue(
                payable(msg.sender),
                nativeBalance - nativeBefore
            );
        }

        emit LocalRebalanceExecuted(destinationRouter, amountIn, requiredDelta);
    }

    function _rebalanceSource(
        MovableCollateralRouter source,
        address expectedSourceRouter,
        uint256 amountIn
    ) internal returns (address destinationRouter) {
        _EXPECTED_SOURCE_ROUTER_SLOT.store(
            TypeCasts.addressToBytes32(expectedSourceRouter)
        );

        // Enters this contract via transferRemote, which escrows source funds
        // and writes the destination recipient into transient storage.
        source.rebalance(localDomain, amountIn, this);
        destinationRouter = TypeCasts.bytes32ToAddress(
            _RESOLVED_DESTINATION_ROUTER_SLOT.loadBytes32()
        );
        if (destinationRouter == address(0)) revert MissingCallback();
        _EXPECTED_SOURCE_ROUTER_SLOT.clear();
        _RESOLVED_DESTINATION_ROUTER_SLOT.clear();
    }

    /// @notice Callback quote used by `MovableCollateralRouter.rebalance`.
    function quoteTransferRemote(
        uint32 destination,
        bytes32,
        uint256 amount
    ) external view override(ITokenFee) returns (Quote[] memory quotes) {
        if (destination != localDomain) revert InvalidCallback();
        address inputToken = MovableCollateralRouter(msg.sender).token();
        if (inputToken == address(0)) revert InvalidToken();

        // Match router rebalance quote semantics: no native fee, exact source
        // token amount pulled by transferRemote.
        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: 0});
        quotes[1] = Quote({token: inputToken, amount: amount});
    }

    /// @notice Router callback. Pulls input into escrow for the active local
    /// rebalance.
    function transferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) external payable override returns (bytes32) {
        bytes32 activeSourceRouter = _EXPECTED_SOURCE_ROUTER_SLOT.loadBytes32();
        if (activeSourceRouter == bytes32(0)) revert NoActiveRebalance();
        if (destination != localDomain) revert InvalidCallback();
        if (TypeCasts.bytes32ToAddress(activeSourceRouter) != msg.sender) {
            revert InvalidCallback();
        }
        if (_RESOLVED_DESTINATION_ROUTER_SLOT.loadBytes32() != bytes32(0)) {
            revert InvalidCallback();
        }

        IERC20(MovableCollateralRouter(msg.sender).token()).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );
        // Captured for localRebalance to resolve the destination router after
        // the source router finishes its rebalance flow.
        _RESOLVED_DESTINATION_ROUTER_SLOT.store(recipient);
        return bytes32(0);
    }

    /// @dev Converts `amountIn` from input-token units to output-token units by
    /// decimals only. Input and output MUST be economically at par (1:1 value
    /// per whole unit); a non-par pair reverts or demands absurd top-ups.
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

    function _refundDelta(
        address token,
        uint256 balanceBefore,
        address recipient
    ) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > balanceBefore) {
            IERC20(token).safeTransfer(recipient, balance - balanceBefore);
        }
    }
}
