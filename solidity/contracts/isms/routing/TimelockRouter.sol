// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {Router} from "../../client/Router.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {IRoutingHook} from "../../interfaces/hooks/IRoutingHook.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title TimelockRouter
 * @notice Combined hook and ISM for time-delayed message verification.
 * @dev This contract serves three roles:
 * 1. Hook: On origin chain, sends message IDs to destination routers
 * 2. Router: On destination chain, receives message IDs and stores readyAt time
 * 3. ISM: On destination chain, verifies messages after the timelock window
 *
 * @dev **Subclass contract**: `postDispatch`, `quoteDispatch`, and `verify`
 * enforce this contract's invariants (notably `_isLatestDispatched(id)`).
 * Subclasses customize via the internal hooks:
 * - `_encodePayload` — cross-chain payload, shared by `postDispatch` and
 *   `quoteDispatch` so the quote tracks the dispatched payload
 * - `_TimelockRouter_onDispatch` — origin-side side effects (sender binding,
 *   replay guards, etc.)
 * - `_handle` — compute a per-message wait and call `_TimelockRouter_commitReadyAt`
 * - `_TimelockRouter_verify` — extend destination-side verification
 * See `DelayedFlowRouterHookIsm` for an amount-sensitive extension.
 */
contract TimelockRouter is
    Router,
    IRoutingHook,
    IPostDispatchHook,
    IInterchainSecurityModule
{
    using Message for bytes;

    // ============ Events ============
    event MessageQueued(bytes32 indexed messageId, uint48 readyAt);

    // ============ Errors ============
    error MessageNotReadyUntil(uint48 readyAt);

    // ============ Immutables ============
    uint48 public immutable timelockWindow;

    // ============ Storage ============
    /// @dev Mapping of message ID => timestamp when message is ready for verification
    mapping(bytes32 messageId => uint48 timestamp) public readyAt;

    // ============ Constructor ============
    constructor(address _mailbox, uint48 _timelockWindow) Router(_mailbox) {
        timelockWindow = _timelockWindow;
    }

    // ============ IPostDispatchHook Implementation ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure virtual returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.ROUTING);
    }

    /// @inheritdoc IRoutingHook
    function hooks(
        uint32 /*destination*/
    ) external view returns (IPostDispatchHook) {
        // always routes to the configured hook
        return hook;
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(
        bytes calldata /*metadata*/
    ) external pure returns (bool) {
        return true;
    }

    /**
     * @inheritdoc IPostDispatchHook
     * @dev Enforces `_isLatestDispatched(id)` — so only a message currently
     * being dispatched through the Mailbox reaches the cross-chain send —
     * then runs subclass side effects via `_TimelockRouter_onDispatch` and
     * forwards `_encodePayload(message)`.
     */
    function postDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external payable {
        require(_isLatestDispatched(message.id()), "message not dispatching");
        _TimelockRouter_onDispatch(message);
        _Router_dispatch(
            message.destination(),
            msg.value,
            _encodePayload(message)
        );
    }

    /// @dev Origin-side side-effect hook, invoked by `postDispatch` after it
    /// enforces `_isLatestDispatched`. Default is a no-op; subclasses override
    /// to add sender binding, replay guards, bucket credits, etc.
    function _TimelockRouter_onDispatch(
        bytes calldata /*message*/
    ) internal virtual {}

    /// @dev The cross-chain payload. Shared by `postDispatch` and
    /// `quoteDispatch` so the quote can never drift from the dispatched
    /// payload. Default carries just the message id; subclasses override to
    /// carry additional data the destination needs.
    function _encodePayload(
        bytes calldata message
    ) internal view virtual returns (bytes memory) {
        return abi.encode(message.id());
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external view returns (uint256) {
        return
            _Router_quoteDispatch(
                message.destination(),
                _encodePayload(message)
            );
    }

    // ============ Router Implementation ============

    /// @inheritdoc Router
    /// @dev Default preverification: decode the id and commit `readyAt` at
    /// the constant `timelockWindow`. Subclasses override this entirely to
    /// derive an amount-sensitive wait, then call
    /// `_TimelockRouter_commitReadyAt` to persist the result.
    function _handle(
        uint32 /*_origin*/,
        bytes32 /*_sender*/,
        bytes calldata payload
    ) internal virtual override {
        bytes32 id = abi.decode(payload, (bytes32));
        _TimelockRouter_commitReadyAt(id, timelockWindow);
    }

    /// @dev Leaf helper for `_handle` overrides: one-shot replay guard and
    /// `readyAt` write. `wait` is the number of seconds the message must be
    /// withheld from the ISM before `verify` will pass.
    function _TimelockRouter_commitReadyAt(bytes32 id, uint48 wait) internal {
        require(
            readyAt[id] == 0,
            "TimelockRouter: message already preverified"
        );
        uint48 messageReadyAt = uint48(block.timestamp) + wait;
        readyAt[id] = messageReadyAt;
        emit MessageQueued(id, messageReadyAt);
    }

    // ============ IInterchainSecurityModule Implementation ============

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external pure virtual returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.NULL);
    }

    /// @inheritdoc IInterchainSecurityModule
    /// @dev Subclasses extend verification via the `_TimelockRouter_verify` hook.
    function verify(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external view returns (bool) {
        return _TimelockRouter_verify(message);
    }

    /// @dev Core `verify` logic. Subclasses extend by overriding this hook
    /// (adding their own checks and delegating to `super`).
    function _TimelockRouter_verify(
        bytes calldata message
    ) internal view virtual returns (bool) {
        bytes32 id = message.id();
        uint48 messageReadyAt = readyAt[id];

        require(messageReadyAt > 0, "TimelockRouter: message not preverified");

        if (messageReadyAt > block.timestamp) {
            revert MessageNotReadyUntil(messageReadyAt);
        }

        return true;
    }
}
