// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AbstractHook} from "./AbstractHook.sol";
import {Message} from "../libs/Message.sol";

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

contract DomainRoutingHook is AbstractHook, Ownable {
    using Message for bytes;

    mapping(uint32 => IPostDispatchHook) public hooks;

    constructor(address _mailbox, address _owner) AbstractHook(_mailbox) {
        _transferOwnership(_owner);
    }

    function setHook(uint32 destination, address hook) external onlyOwner {
        hooks[destination] = IPostDispatchHook(hook);
    }

    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
    {
        hooks[message.destination()].postDispatch{value: msg.value}(
            metadata,
            message
        );
    }
}
