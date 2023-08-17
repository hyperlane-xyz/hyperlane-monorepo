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

import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";

contract ConfigFallbackDomainRoutingHook is IPostDispatchHook {
    using Message for bytes;

    IMailbox public immutable mailbox;

    /// @notice message sender => destination => recipient => hook
    mapping(address => mapping(uint32 => mapping(bytes32 => IPostDispatchHook)))
        public customHooks;

    constructor(address _mailbox) {
        mailbox = IMailbox(_mailbox);
    }

    function postDispatch(bytes calldata metadata, bytes calldata message)
        public
        payable
        override
    {
        _getConfiguredHook(message).postDispatch{value: msg.value}(
            metadata,
            message
        );
    }

    function quoteDispatch(bytes calldata metadata, bytes calldata message)
        public
        view
        returns (uint256)
    {
        return _getConfiguredHook(message).quoteDispatch(metadata, message);
    }

    function setHook(
        uint32 destinationDomain,
        bytes32 recipient,
        IPostDispatchHook hook
    ) external {
        customHooks[msg.sender][destinationDomain][recipient] = hook;
    }

    // ============ Internal Functions ============

    function _getConfiguredHook(bytes calldata message)
        internal
        view
        returns (IPostDispatchHook)
    {
        IPostDispatchHook configuredHook = customHooks[message.senderAddress()][
            message.destination()
        ][message.recipient()];
        if (address(configuredHook) == address(0)) {
            configuredHook = mailbox.defaultHook();
        }
        return configuredHook;
    }
}
