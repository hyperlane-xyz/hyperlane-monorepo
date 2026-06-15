// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, ITokenFee, Quote} from "../interfaces/ITokenBridge.sol";
import {TransientStorage} from "../libs/TransientStorage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {ReentrancyGuardTransient} from "../libs/ReentrancyGuardTransient.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";
import {IRebalanceTargets} from "./interfaces/IRebalanceTargets.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @dev Balances held by the wrapper itself, snapshotted before escrow so
/// balances already present (donations or prior escrow) cannot fund the
/// destination or be swept as a refund. Used to avoid stack too deep.
struct SelfBalanceSnapshot {
    uint256 nativeToken;
    uint256 inputToken;
    uint256 outputToken;
}

/// @dev Input/output token balances held by the source and destination routers,
/// snapshotted before escrow to bound how much the calls may move. Used to avoid stack too deep.
struct CollateralRoutersBalanceSnapshot {
    uint256 sourceRouter;
    uint256 destinationRouter;
}

/// @title AtomicLocalRebalancingBridge
/// @notice Same-chain `ITokenBridge` rebalancer wrapper for atomic local rebalances.
/// @dev The wrapper is bound to a single immutable source router and must be
/// configured as an allowed rebalancer/bridge on it. The source MUST be a
/// `CrossCollateralRouter` (the only `IRebalanceTargets` implementer); this is
/// asserted in the constructor.
/// @dev The destination is supplied per call and validated against the source's
/// rebalance targets (`isRebalanceTarget`). It MUST hold a token economically at
/// par with the source collateral: output is converted from input by decimals
/// only, so a non-par target reverts or demands absurd top-ups. Par is a
/// configuration-only invariant, under the same trust model as cross-collateral
/// routing.
/// @dev `source.rebalance` resolves and uses the source's own configured
/// recipient for its `CollateralMoved` event/quote, but this wrapper ignores the
/// callback recipient and funds the validated `destinationRecipient` argument.
contract AtomicLocalRebalancingBridge is
    ITokenBridge,
    PackageVersioned,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;
    using TransientStorage for bytes32;

    /// @dev Stores the expected source router during escrow; consumed by
    /// `transferRemote`. Non-zero only between escrow start and its callback.
    bytes32 private constant _CALLBACK_ACTIVE_SLOT =
        keccak256("hyperlane.atomicLocalRebalancingBridge.callbackActive");

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
    error InvalidSource();
    error InvalidRecipient();

    constructor(uint32 _localDomain, address _sourceRouter) {
        // Native-collateral sources are unsupported (decimal conversion needs an
        // ERC20); reject them up front since the source is bound here.
        if (MovableCollateralRouter(_sourceRouter).token() == address(0)) {
            revert InvalidToken();
        }
        // The source must expose IRebalanceTargets so destinations can be
        // validated. A high-level call enforces valid bool returndata, rejecting
        // contracts that don't implement it (CrossCollateralRouter only).
        try
            IRebalanceTargets(_sourceRouter).isRebalanceTarget(
                _localDomain,
                bytes32(0)
            )
        returns (bool) {} catch {
            revert InvalidSource();
        }

        localDomain = _localDomain;
        sourceRouter = _sourceRouter;
    }

    /// @notice Executes a same-chain rebalance into a validated destination
    /// router.
    /// @param sourceRouter_ Must equal the immutable `sourceRouter` (checked echo
    /// kept for signature compatibility with the canonical rebalance flow).
    /// @param destinationRecipient EVM-address-encoded `bytes32` (upper 96 bits
    /// zero) of an allowed rebalance target; funded via `bytes32ToAddress`.
    /// @param data ABI-encoded `CallLib.Call[]` run after escrow (token approvals
    /// and DEX swaps). Calls must leave enough output token on this wrapper to pay
    /// the destination router.
    function rebalance(
        uint32 domain,
        uint256 collateralAmount,
        ITokenBridge sourceRouter_,
        bytes32 destinationRecipient,
        bytes calldata data
    ) external payable nonReentrant {
        if (domain != localDomain) revert InvalidCallback();
        if (address(sourceRouter_) != sourceRouter) revert InvalidSource();

        MovableCollateralRouter source = MovableCollateralRouter(sourceRouter);
        if (!source.isAllowedRebalancer(msg.sender)) {
            revert UnauthorizedRebalancer();
        }

        if (
            !IRebalanceTargets(sourceRouter).isRebalanceTarget(
                localDomain,
                destinationRecipient
            )
        ) {
            revert InvalidRecipient();
        }
        address destinationRouter = TypeCasts.bytes32ToAddress(
            destinationRecipient
        );

        address inputToken = source.token();
        if (inputToken == address(0)) revert InvalidToken();
        address outputToken = MovableCollateralRouter(destinationRouter)
            .token();
        if (outputToken == address(0)) revert InvalidToken();
        uint256 requiredDelta = _requiredDelta(
            inputToken,
            outputToken,
            collateralAmount
        );

        uint256 wrapperInputBefore = IERC20(inputToken).balanceOf(
            address(this)
        );
        SelfBalanceSnapshot memory selfBefore = SelfBalanceSnapshot({
            // Excludes pre-existing native from the refund.
            nativeToken: address(this).balance - msg.value,
            inputToken: wrapperInputBefore,
            // Shared input/output token reuses the input snapshot; otherwise
            // exclude any output-token donation.
            outputToken: outputToken == inputToken
                ? wrapperInputBefore
                : IERC20(outputToken).balanceOf(address(this))
        });

        CollateralRoutersBalanceSnapshot
            memory routersBefore = CollateralRoutersBalanceSnapshot({
                sourceRouter: IERC20(inputToken).balanceOf(sourceRouter),
                destinationRouter: IERC20(outputToken).balanceOf(
                    destinationRouter
                )
            });

        _pullSourceCollateral(source, collateralAmount);

        CallLib.multicall(abi.decode(data, (CallLib.Call[])));

        if (address(this).balance < selfBefore.nativeToken) {
            revert InvalidNativeDelta();
        }
        // Source may be topped up, but calls must not drain more than the amount.
        if (
            IERC20(inputToken).balanceOf(sourceRouter) <
            routersBefore.sourceRouter - collateralAmount
        ) {
            revert InvalidInputDelta();
        }
        // Calls must not spend the wrapper's pre-call input donation.
        if (
            IERC20(inputToken).balanceOf(address(this)) < selfBefore.inputToken
        ) {
            revert InvalidInputDelta();
        }
        // Calls must produce at least requiredDelta of new output; donations
        // and escrow already on the wrapper cannot fund the destination.
        if (
            IERC20(outputToken).balanceOf(address(this)) <
            selfBefore.outputToken + requiredDelta
        ) {
            revert InsufficientOutput();
        }
        IERC20(outputToken).safeTransfer(destinationRouter, requiredDelta);
        if (
            IERC20(outputToken).balanceOf(destinationRouter) <
            routersBefore.destinationRouter + requiredDelta
        ) {
            revert InsufficientOutput();
        }
        // Refund only balances accrued during this call; never sweep donations.
        _refundDelta(inputToken, selfBefore.inputToken, msg.sender);
        if (outputToken != inputToken) {
            _refundDelta(outputToken, selfBefore.outputToken, msg.sender);
        }
        // Refund this call's unspent native.
        uint256 nativeBalance = address(this).balance;
        if (nativeBalance > selfBefore.nativeToken) {
            Address.sendValue(
                payable(msg.sender),
                nativeBalance - selfBefore.nativeToken
            );
        }

        emit LocalRebalanceExecuted(
            destinationRouter,
            collateralAmount,
            requiredDelta
        );
    }

    /// @dev Pulls `collateralAmount` of source collateral into this wrapper via
    /// the source's canonical rebalance flow, which calls back into
    /// `transferRemote`. The callback slot authenticates and is consumed by that
    /// single callback; this enforces exactly one pull and blocks any further
    /// callback during the arbitrary calls or refunds below.
    function _pullSourceCollateral(
        MovableCollateralRouter source,
        uint256 collateralAmount
    ) internal {
        _CALLBACK_ACTIVE_SLOT.store(
            TypeCasts.addressToBytes32(address(source))
        );

        source.rebalance(localDomain, collateralAmount, this);
        if (_CALLBACK_ACTIVE_SLOT.loadBytes32() != bytes32(0)) {
            revert MissingCallback();
        }
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
    /// rebalance. The `recipient` argument is ignored; the destination is the
    /// validated `destinationRecipient` from `rebalance`.
    function transferRemote(
        uint32 destination,
        bytes32,
        uint256 amount
    ) external payable override returns (bytes32) {
        bytes32 activeSourceRouter = _CALLBACK_ACTIVE_SLOT.loadBytes32();
        if (activeSourceRouter == bytes32(0)) revert NoActiveRebalance();
        if (destination != localDomain) revert InvalidCallback();
        if (TypeCasts.bytes32ToAddress(activeSourceRouter) != msg.sender) {
            revert InvalidCallback();
        }
        // Consume the callback before the external transfer (checks-effects-
        // interactions): enforces exactly one escrow and ensures any reentry
        // triggered by the transfer sees no active callback.
        _CALLBACK_ACTIVE_SLOT.clear();

        IERC20(MovableCollateralRouter(msg.sender).token()).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );
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
