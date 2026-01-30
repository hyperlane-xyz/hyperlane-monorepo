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
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @title TimelockRouter
 * @notice Combined hook and ISM for time-delayed message verification.
 * @dev This contract serves three roles:
 * 1. Hook: On origin chain, sends message IDs to destination routers
 * 2. Router: On destination chain, receives message IDs and stores readyAt time
 * 3. ISM: On destination chain, verifies messages after the timelock window
 */
contract TimelockRouter is
    Router,
    IRoutingHook,
    IPostDispatchHook,
    IInterchainSecurityModule
{
    using Message for bytes;
    using StandardHookMetadata for bytes;
    using TypeCasts for address;

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
    function hookType() external pure returns (uint8) {
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

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external payable {
        // Send message ID to destination router for preverification
        _Router_dispatch(
            message.destination(),
            msg.value,
            abi.encode(message.id())
        );
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external view returns (uint256) {
        uint32 destination = message.destination();
        bytes memory payload = abi.encode(message.id());

        return _Router_quoteDispatch(destination, payload);
    }

    // ============ Router Implementation ============

    /// @inheritdoc Router
    function _handle(
        uint32 /* _origin */,
        bytes32 /* _sender */,
        bytes calldata _message
    ) internal override {
        // Decode the message ID from the payload
        bytes32 messageId = abi.decode(_message, (bytes32));

        // Mark message as preverified with readyAt time
        require(
            readyAt[messageId] == 0,
            "TimelockRouter: message already preverified"
        );
        uint48 messageReadyAt = uint48(block.timestamp) + timelockWindow;
        readyAt[messageId] = messageReadyAt;

        emit MessageQueued(messageId, messageReadyAt);
    }

    // ============ IInterchainSecurityModule Implementation ============

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.NULL);
    }

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata /* metadata */,
        bytes calldata message
    ) external view returns (bool) {
        bytes32 messageId = message.id();
        uint48 messageReadyAt = readyAt[messageId];

        require(messageReadyAt > 0, "TimelockRouter: message not preverified");

        if (messageReadyAt > block.timestamp) {
            revert MessageNotReadyUntil(messageReadyAt);
        }

        return true;
    }
}
