// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Indexed} from "../libs/Indexed.sol";
import {Message} from "../libs/Message.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

contract MappingHook is MailboxClient, IPostDispatchHook {
    using Message for bytes;

    mapping(uint32 => bytes32) public dispatchedMessageIds;

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    function supportsMetadata(bytes calldata)
        external
        pure
        override
        returns (bool)
    {
        return true;
    }

    function postDispatch(bytes calldata, bytes calldata message)
        external
        payable
        override
    {
        bytes32 id = message.id();
        require(
            _isLatestDispatched(id),
            "MappingHook: message not dispatching"
        );
        dispatchedMessageIds[message.nonce()] = id;
    }

    function quoteDispatch(bytes calldata, bytes calldata)
        public
        pure
        override
        returns (uint256)
    {
        return 0;
    }
}
