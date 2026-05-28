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
 * @dev **Subclass contract**: subclasses customize behavior by overriding
 * `postDispatch` (and **must** route their cross-chain dispatch through
 * `_TimelockRouter_assertLatestAndDispatch`, which enforces the
 * `_isLatestDispatched` invariant) and `_handle` (computing a per-message
 * wait and calling `_TimelockRouter_commitReadyAt`). `verify` can be
 * extended via `_TimelockRouter_verify`. See `DelayedFlowRouter` for an
 * amount-sensitive extension.
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
     * @dev Subclasses override this to add domain-specific checks (sender
     * binding, replay guards, etc.) but **must** route the cross-chain
     * dispatch through `_TimelockRouter_assertLatestAndDispatch` so the
     * `_isLatestDispatched(id)` invariant is enforced. Bypassing the helper
     * is a footgun.
     */
    function postDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external payable virtual {
        bytes32 id = message.id();
        _TimelockRouter_assertLatestAndDispatch(
            id,
            message.destination(),
            abi.encode(id)
        );
    }

    /// @dev Asserts `_isLatestDispatched(id)` and forwards `payload`
    /// cross-chain. Subclasses **must** invoke this from their `postDispatch`
    /// override — calling `_Router_dispatch` directly skips the invariant.
    function _TimelockRouter_assertLatestAndDispatch(
        bytes32 id,
        uint32 destination,
        bytes memory payload
    ) internal {
        require(_isLatestDispatched(id), "message not dispatching");
        _Router_dispatch(destination, msg.value, payload);
    }

    function quoteDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external view virtual returns (uint256) {
        return
            _Router_quoteDispatch(
                message.destination(),
                abi.encode(message.id())
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
    function verify(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external view virtual returns (bool) {
        return _TimelockRouter_verify(message);
    }

    /// @dev Core `verify` logic. Subclasses can extend by overriding `verify`
    /// and delegating here, or override this helper directly.
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
