// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {DefaultHookMetadata} from "../libs/hooks/DefaultHookMetadata.sol";
import {DynamicBufferLib} from "../libs/DynamicBufferLib.sol";
import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {DomainRoutingHook} from "./DomainRoutingHook.sol";

contract DefaultHook is DomainRoutingHook {
    using DefaultHookMetadata for bytes;
    using DynamicBufferLib for DynamicBufferLib.Stack;
    using Message for bytes;

    DynamicBufferLib.Stack internal hooksBuffer;

    mapping(bytes32 => address) public customHooks;

    constructor(address mailbox, address owner)
        DomainRoutingHook(mailbox, owner)
    {}

    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
        returns (address[] memory)
    {
        // check metadata for custom hook
        if (metadata.length > 0) {
            bytes32 hookKey = keccak256(
                abi.encodePacked(
                    metadata.variant(),
                    message.destination(),
                    message.recipient()
                )
            );

            require(
                customHooks[hookKey] != address(0),
                "DefaultHook: no hook specified"
            );
            hooksBuffer.push(customHooks[hookKey]);
        } else {
            hooksBuffer.push(address(hooks[message.destination()]));
        }

        // loop through hooks until empty stack
        while (!hooksBuffer.isEmpty()) {
            address[] memory moreHooks = IPostDispatchHook(hooksBuffer.pop())
                .postDispatch(metadata, message);
            hooksBuffer.push(moreHooks);
        }
        return new address[](1);
    }

    // restrict to first sender
    function configCustomHook(
        uint8 variant,
        uint32 destinationDomain,
        bytes32 recipient,
        address hook
    ) external {
        bytes32 hookKey = keccak256(
            abi.encodePacked(variant, destinationDomain, recipient)
        );
        customHooks[hookKey] = hook;
    }
}
