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
import {IRebalancingBridge} from "./interfaces/IRebalancingBridge.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @dev Balances held by this contract, snapshotted before escrow: the post-call
/// invariants require new output (not pre-existing balances) to fund the
/// destination, and the refund returns only balances accrued during the call.
/// `native` excludes this call's `msg.value`. Used to avoid stack too deep.
struct SelfBalanceSnapshot {
    uint256 sourceToken;
    uint256 destinationToken;
    uint256 native;
}

/// @title AtomicLocalRebalancingBridge
/// @notice Same-chain `ITokenBridge` rebalancer wrapper for atomic local rebalances.
/// @dev The wrapper is bound to a single immutable source router and must be
/// configured as an allowed rebalancer/bridge on it. The source MUST implement
/// `IRebalanceTargets`, used to authorize destinations.
///
/// @dev The destination is supplied per call and validated against the source's
/// rebalance targets (`isRebalanceTarget`). It MUST hold a token economically at
/// par with the source collateral: output is converted from input by decimals
/// only, so a non-par target reverts or demands absurd top-ups. Par is a
/// configuration-only invariant, under the same trust model as cross-collateral
/// routing.
///
/// @dev `source.rebalance` resolves and uses the source's own configured
/// recipient for its `CollateralMoved` event/quote, but this wrapper ignores the
/// callback recipient and funds the validated `destinationRecipient` argument.
/// @dev Operating invariants the bridge is expected to hold:
/// - Only an allowlisted rebalancer may call `rebalance`; the post-call invariants
///   bound a compromised or buggy rebalancer, since the calls run arbitrary code.
/// - A rebalance moves at most `amount` out of the source router and funds the
///   destination only with output the calls produce.
/// - The bridge keeps no value of its own: any balance present before a call is
///   neither consumed to fund the destination nor refunded to the rebalancer.
contract AtomicLocalRebalancingBridge is
    IRebalancingBridge,
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

    /// @notice The source router this bridge is allowed to rebalance from.
    address public immutable allowedSourceRouter;

    /// @notice Emitted on a successful local rebalance.
    event LocalRebalanceExecuted(
        address indexed destinationRouter,
        uint256 amountIn,
        uint256 requiredOutputAmount
    );

    error NoActiveRebalance();
    error InvalidCallback();
    error MissingCallback();
    error UnauthorizedRebalancer();
    error InvalidToken();
    error InvalidSource();
    error InvalidRecipient();

    // Post-call invariant revert reasons.
    string internal constant ERR_SOURCE_ROUTER_OVERDRAWN =
        "ALRB: source router overdrawn";
    string internal constant ERR_PREEXISTING_SOURCE_SPENT =
        "ALRB: pre-existing source spent";
    string internal constant ERR_PREEXISTING_NATIVE_SPENT =
        "ALRB: pre-existing native spent";
    string internal constant ERR_INSUFFICIENT_OUTPUT =
        "ALRB: insufficient output produced";

    constructor(uint32 _localDomain, address _sourceRouter) {
        if (!Address.isContract(_sourceRouter)) revert InvalidSource();
        localDomain = _localDomain;
        allowedSourceRouter = _sourceRouter;
    }

    /// @notice Executes a same-chain rebalance into a validated destination
    /// router.
    /// @param sourceRouter Must equal `allowedSourceRouter` (checked echo kept for
    /// signature compatibility with the canonical rebalance flow).
    /// @param destinationRecipient EVM-address-encoded `bytes32` (upper 96 bits
    /// zero) of an allowed rebalance target; funded via `bytes32ToAddress`.
    /// @param data ABI-encoded `CallLib.Call[]` run after escrow (token approvals
    /// and DEX swaps). Calls must leave enough output token on this wrapper to pay
    /// the destination router.
    function rebalance(
        uint32 domain,
        uint256 amount,
        ITokenBridge sourceRouter,
        bytes32 destinationRecipient,
        bytes calldata data
    ) external payable override nonReentrant {
        MovableCollateralRouter source = _validateAndParseSourceRouter(
            domain,
            sourceRouter
        );
        address destinationRouter = _validateAndParseDestinationAddress(
            destinationRecipient
        );

        // Resolve the source and destination collateral tokens; both must be a
        // non-native ERC20 (token() != address(0)).
        address sourceToken = source.token();
        if (sourceToken == address(0)) revert InvalidToken();
        address destinationToken = MovableCollateralRouter(destinationRouter)
            .token();
        if (destinationToken == address(0)) revert InvalidToken();
        uint256 requiredOutputAmount = _requiredOutputAmount(
            sourceToken,
            destinationToken,
            amount
        );

        // Snapshot balances before escrow so the post-call invariants and the
        // refund can isolate what the rebalancer's calls moved.
        SelfBalanceSnapshot memory selfBefore = _snapshotSelfTokenBalances(
            sourceToken,
            destinationToken
        );
        uint256 sourceRouterBalanceBefore = IERC20(sourceToken).balanceOf(
            allowedSourceRouter
        );

        // Escrow the source collateral, then run the rebalancer's calls.
        _pullSourceRouterCollateral(source, amount);
        CallLib.multicall(abi.decode(data, (CallLib.Call[])));

        _validatePostCallBalances(
            sourceToken,
            destinationToken,
            amount,
            requiredOutputAmount,
            sourceRouterBalanceBefore,
            selfBefore
        );

        // Fund the destination with the output the calls produced.
        IERC20(destinationToken).safeTransfer(
            destinationRouter,
            requiredOutputAmount
        );

        // Refund balances accrued during the call; pre-existing balances untouched.
        _refundAccruedBalances(sourceToken, destinationToken, selfBefore);

        emit LocalRebalanceExecuted(
            destinationRouter,
            amount,
            requiredOutputAmount
        );
    }

    // ============ Internal ============

    /// @dev Validates the rebalance gate conditions — local domain, the source echo
    /// matches the bound router, and the caller is an allowed rebalancer — and
    /// returns the bound source router as a `MovableCollateralRouter`.
    function _validateAndParseSourceRouter(
        uint32 domain,
        ITokenBridge sourceRouter
    ) internal view returns (MovableCollateralRouter source) {
        if (domain != localDomain) {
            revert InvalidCallback();
        }

        if (address(sourceRouter) != allowedSourceRouter) {
            revert InvalidSource();
        }

        source = MovableCollateralRouter(allowedSourceRouter);
        if (!source.isAllowedRebalancer(msg.sender)) {
            revert UnauthorizedRebalancer();
        }
    }

    /// @dev Validates `destinationRecipient` against the source's rebalance targets
    /// and returns the destination router address it encodes.
    function _validateAndParseDestinationAddress(
        bytes32 destinationRecipient
    ) internal view returns (address) {
        if (
            !IRebalanceTargets(allowedSourceRouter).isRebalanceTarget(
                localDomain,
                destinationRecipient
            )
        ) {
            revert InvalidRecipient();
        }

        return TypeCasts.bytes32ToAddress(destinationRecipient);
    }

    /// @dev Snapshots the balances this contract holds before escrow. The post-call
    /// invariants require new output (not pre-existing balances) to fund the
    /// destination, and the refund returns only balances accrued during the call.
    /// `native` excludes this call's `msg.value`.
    function _snapshotSelfTokenBalances(
        address sourceToken,
        address destinationToken
    ) internal view returns (SelfBalanceSnapshot memory) {
        uint256 sourceBalanceBefore = IERC20(sourceToken).balanceOf(
            address(this)
        );

        return
            SelfBalanceSnapshot({
                sourceToken: sourceBalanceBefore,
                // A shared source/destination token reuses the source snapshot (a
                // same-asset rebalance funds the destination straight from escrow
                // with no swap); otherwise exclude any pre-existing destination
                // balance.
                destinationToken: destinationToken == sourceToken
                    ? sourceBalanceBefore
                    : IERC20(destinationToken).balanceOf(address(this)),
                native: address(this).balance - msg.value
            });
    }

    /// @dev Pulls `amount` of source collateral into this wrapper via
    /// the source's canonical rebalance flow, which calls back into
    /// `transferRemote`. The callback slot authenticates and is consumed by that
    /// single callback; this enforces exactly one pull and blocks any further
    /// callback during the arbitrary calls or refunds below.
    function _pullSourceRouterCollateral(
        MovableCollateralRouter source,
        uint256 amount
    ) internal {
        _CALLBACK_ACTIVE_SLOT.store(
            TypeCasts.addressToBytes32(address(source))
        );

        source.rebalance(localDomain, amount, this);
        if (_CALLBACK_ACTIVE_SLOT.loadBytes32() != bytes32(0)) {
            revert MissingCallback();
        }
    }

    /// @dev Post-call invariants. The calls run with this wrapper's privileges, so
    /// these bound what they can do: the source router is not drained beyond the
    /// escrowed `amount`, the wrapper's pre-existing source and native balances are
    /// untouched, and enough new output is produced to fund the destination.
    function _validatePostCallBalances(
        address sourceToken,
        address destinationToken,
        uint256 amount,
        uint256 requiredOutputAmount,
        uint256 sourceRouterBalanceBefore,
        SelfBalanceSnapshot memory selfBefore
    ) internal view {
        // The source router may be topped up, but not drained beyond `amount`.
        require(
            IERC20(sourceToken).balanceOf(allowedSourceRouter) >=
                sourceRouterBalanceBefore - amount,
            ERR_SOURCE_ROUTER_OVERDRAWN
        );

        // Calls may consume at most the escrowed amount, never source collateral
        // this contract already held before escrow.
        require(
            IERC20(sourceToken).balanceOf(address(this)) >=
                selfBefore.sourceToken,
            ERR_PREEXISTING_SOURCE_SPENT
        );

        // Calls may spend this call's `msg.value`, never pre-existing native.
        require(
            address(this).balance >= selfBefore.native,
            ERR_PREEXISTING_NATIVE_SPENT
        );

        // Calls must produce at least requiredOutputAmount of new output; balances
        // already held cannot fund the destination.
        require(
            IERC20(destinationToken).balanceOf(address(this)) >=
                selfBefore.destinationToken + requiredOutputAmount,
            ERR_INSUFFICIENT_OUTPUT
        );
    }

    /// @dev Refunds the token and native balances accrued during the call to the
    /// rebalancer; balances the wrapper held before escrow are left untouched.
    function _refundAccruedBalances(
        address sourceToken,
        address destinationToken,
        SelfBalanceSnapshot memory selfBefore
    ) internal {
        _refundTokenBalance(sourceToken, selfBefore.sourceToken, msg.sender);
        if (destinationToken != sourceToken) {
            _refundTokenBalance(
                destinationToken,
                selfBefore.destinationToken,
                msg.sender
            );
        }

        uint256 nativeBalance = address(this).balance;
        if (nativeBalance > selfBefore.native) {
            Address.sendValue(
                payable(msg.sender),
                nativeBalance - selfBefore.native
            );
        }
    }

    /// @notice Callback quote used by `MovableCollateralRouter.rebalance`.
    function quoteTransferRemote(
        uint32 destination,
        bytes32,
        uint256 amount
    ) external view override(ITokenFee) returns (Quote[] memory quotes) {
        if (destination != localDomain) revert InvalidCallback();
        address sourceToken = MovableCollateralRouter(msg.sender).token();
        if (sourceToken == address(0)) revert InvalidToken();

        // Match router rebalance quote semantics: no native fee, exact source
        // token amount pulled by transferRemote.
        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: 0});
        quotes[1] = Quote({token: sourceToken, amount: amount});
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

    /// @dev Converts `amountIn` from source-token units to destination-token
    /// units by decimals only. Source and destination MUST be economically at par
    /// (1:1 value per whole unit); a non-par pair reverts or demands absurd top-ups.
    /// Both tokens must implement `decimals()`, and the invariant assumes
    /// standard balance-stable ERC20 behavior: no fee-on-transfer, reflection,
    /// rebasing, or balance-altering hooks. Incompatible assets should be
    /// wrapped or adapted before using this bridge.
    function _requiredOutputAmount(
        address sourceToken,
        address destinationToken,
        uint256 amountIn
    ) internal view returns (uint256 requiredOutputAmount) {
        uint256 sourceScale = _decimalScale(sourceToken);
        uint256 destinationScale = _decimalScale(destinationToken);
        if (sourceScale == destinationScale) return amountIn;
        // Round up so decimal conversion never underfunds the destination.
        return
            Math.mulDiv(
                amountIn,
                destinationScale,
                sourceScale,
                Math.Rounding.Up
            );
    }

    /// @dev Reverts if `token` does not implement `IERC20Metadata.decimals()`.
    function _decimalScale(address token) internal view returns (uint256) {
        return 10 ** uint256(IERC20Metadata(token).decimals());
    }

    function _refundTokenBalance(
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
