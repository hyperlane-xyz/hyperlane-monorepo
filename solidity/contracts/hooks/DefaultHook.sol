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

import "forge-std/console.sol";

import {DefaultHookMetadata} from "../libs/hooks/DefaultHookMetadata.sol";
import {DynamicBufferLib} from "../libs/DynamicBufferLib.sol";
import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {DomainRoutingHook} from "./DomainRoutingHook.sol";

contract DefaultHook is DomainRoutingHook {
    using DynamicBufferLib for DynamicBufferLib.Stack;
    using Message for bytes;

    DynamicBufferLib.Stack internal hooksBuffer;

    mapping(bytes32 => address[]) public customHooks;

    constructor(address mailbox, address owner)
        DomainRoutingHook(mailbox, owner)
    {}

    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
        returns (address[] memory)
    {
        bytes32 hookKey = keccak256(
            abi.encodePacked(message.destination(), message.recipient())
        );
        if (customHooks[hookKey].length > 0) {
            hooksBuffer = hooksBuffer.push(customHooks[hookKey]);
        } else {
            hooksBuffer.push(address(hooks[message.destination()]));
        }

        address nextHook;
        // loop through hooks until empty stack
        while (!hooksBuffer.isEmpty()) {
            (hooksBuffer, nextHook) = hooksBuffer.pop();
            address[] memory moreHooks = IPostDispatchHook(nextHook)
                .postDispatch{value: msg.value}(metadata, message);
            hooksBuffer.push(moreHooks);
        }
        return new address[](1);
    }

    // restrict to first sender
    function configCustomHook(
        uint32 destinationDomain,
        bytes32 recipient,
        address[] calldata hooks
    ) external {
        bytes32 hookKey = keccak256(
            abi.encodePacked(destinationDomain, recipient)
        );
        customHooks[hookKey] = hooks;
    }
}
