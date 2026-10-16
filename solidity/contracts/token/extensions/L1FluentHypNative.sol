// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../HypNative.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {NativeCollateral} from "../libs/TokenCollateral.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @dev Minimal inline view of `L1HypNativeGateway.sendNativeTokens`. Inlined here so this
 *      contract stays self-contained — the Hyperlane monorepo cannot take a source-level
 *      dependency on `fluentlabs/solidity-contracts`. Canonical declaration lives at
 *      `contracts/interfaces/gateways/IHypNativeGateway.sol → IL1HypNativeGateway` in the
 *      Fluent repo. The gateway internally re-encodes the L2 payload and forwards through
 *      `FluentBridge.sendMessage`, so this interface is the only Fluent-side surface this
 *      warp route touches.
 */
interface IL1HypNativeGateway {
    /// @notice Forwards an inbound Hyperlane delivery as native ETH to Fluent L2.
    /// @dev `msg.value` is the entire amount delivered on L2. Gateway-side auth is
    ///      `msg.sender == configured warp route`, so this warp route must be set as
    ///      `L1HypNativeGateway._warpRoute` via `setWarpRoute()` before inbound traffic
    ///      can flow.
    function sendNativeTokens(address to) external payable;
}

/**
 * @title L1FluentHypNative
 * @author Fluent Labs
 *
 * @notice Custom Hyperlane warp route on Ethereum: forwards inbound native-ETH Hyperlane
 *         deliveries through `L1HypNativeGateway.sendNativeTokens` to Fluent L2 instead
 *         of releasing ETH on L1. The gateway wraps `FluentBridge.sendMessage` together
 *         with rate-limit and blacklist enforcement, so this warp route only knows about
 *         the gateway. Outbound (`transferRemote`) is unchanged from stock {HypNative} so
 *         the existing `L1HypNativeGateway` L2→external flow keeps working against this
 *         implementation.
 *
 * @dev Inbound contract: {_handle} is overridden — NOT {_transferTo} — because
 *      {_transferTo} is the shared primitive for *all* outbound native pushes from this
 *      router, including ERC4626 LP withdrawals via {LpCollateralRouter._withdraw} and
 *      fee distribution. Overriding it would redirect those flows through the L2 gateway,
 *      which is wrong: LPs and `feeRecipient`s expect to receive ETH on L1. {_handle} is
 *      the Hyperlane-delivery–specific seam, so the override lives there.
 *
 *      Deployment ordering: the gateway must call `setWarpRoute(address(this))` after
 *      this contract is deployed and registered, otherwise inbound deliveries revert at
 *      the gateway with `UnauthorizedWarpRoute`. That revert is itself benign — see the
 *      revert-and-retry note below — but until the wiring is in place no inbound message
 *      will be delivered.
 *
 *      Revert-and-retry: if anything in the gateway → bridge chain reverts
 *      (`UnauthorizedWarpRoute`, `InvalidRecipient`, recipient blacklist hit, bridge
 *      paused, destination de-whitelisted), {_handle} reverts → `Mailbox.process`
 *      atomically rolls back `deliveries[_id]` → the message stays retryable via
 *      permissionless `Mailbox.process(_metadata, _message)`. This matches every
 *      Hyperlane warp route in upstream and is the canonical recovery mechanism. There
 *      is intentionally no quarantine bucket.
 *
 *      Zero-recipient guard: a message decoded with `recipient == address(0)` is rejected
 *      here with {ZeroRecipient} rather than at the gateway. The gateway would also
 *      revert in this case, but its revert recurs indefinitely on every retry, turning
 *      the message into a permanent retry tombstone. Failing fast at the warp route gives
 *      monitoring a clear, locally-owned error to alert on.
 *
 *      Fee handling: {_transferFee} is overridden to keep protocol-fee delivery on L1
 *      (canonical pattern from {TokenBridgeCctpBase} / {EverclearTokenBridge}). Without
 *      this, a configured `feeRecipient` would receive its share on L2 instead of L1.
 *
 *      Storage: zero new storage slots. All Fluent-specific config is `immutable`.
 *      Deployed behind a `TransparentUpgradeableProxy` like every other warp route in
 *      this repo; the proxy admin gates upgrades and is distinct from the
 *      `OwnableUpgradeable` owner inherited from {HypNative}.
 */
contract L1FluentHypNative is HypNative {
    using TypeCasts for bytes32;
    using TokenMessage for bytes;

    /// @notice The `L1HypNativeGateway` that forwards inbound deliveries through Fluent's
    ///         L1↔L2 bridge. Must be configured to recognize this warp route as its
    ///         authorized caller (`L1HypNativeGateway.setWarpRoute(address(this))`).
    IL1HypNativeGateway public immutable l1HypNativeGateway;

    error GatewayAddressZero();
    error ZeroRecipient();

    constructor(
        uint256 _scaleNumerator,
        uint256 _scaleDenominator,
        address _mailbox,
        address _l1HypNativeGateway
    ) HypNative(_scaleNumerator, _scaleDenominator, _mailbox) {
        if (_l1HypNativeGateway == address(0)) revert GatewayAddressZero();
        l1HypNativeGateway = IL1HypNativeGateway(_l1HypNativeGateway);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Decodes the canonical Hyperlane token message, applies inbound scaling, and
     *      forwards the native amount through `L1HypNativeGateway.sendNativeTokens`
     *      instead of releasing ETH on L1. The {ReceivedTransferRemote} event is emitted
     *      with the unscaled message amount for indexer parity with stock {HypNative}.
     *      Reverts with {ZeroRecipient} on `recipient == address(0)` so a malformed
     *      source-chain dispatch surfaces immediately at this contract instead of
     *      cycling through gateway-level retries.
     */
    function _handle(
        uint32 _origin,
        bytes32 /*_sender*/,
        bytes calldata _message
    ) internal override {
        bytes32 recipientBytes = _message.recipient();
        address recipient = recipientBytes.bytes32ToAddress();
        if (recipient == address(0)) revert ZeroRecipient();

        uint256 messageAmount = _message.amount();
        uint256 localAmount = _inboundAmount(messageAmount);

        emit ReceivedTransferRemote(_origin, recipientBytes, messageAmount);

        l1HypNativeGateway.sendNativeTokens{value: localAmount}(recipient);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Keep protocol-fee delivery on L1 instead of forwarding through
     *      {l1HypNativeGateway} to L2 (which is where the default
     *      `_transferFee → _transferTo` would route it). `feeRecipient` is an L1 address.
     */
    function _transferFee(
        address _recipient,
        uint256 _amount
    ) internal override {
        NativeCollateral._transferTo(_recipient, _amount);
    }
}
