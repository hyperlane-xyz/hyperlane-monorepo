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
    using DefaultHookMetadata for bytes;
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
        // check metadata for custom hook
        if (metadata.length > 0) {
            bytes32 hookKey = keccak256(
                abi.encodePacked(
                    metadata.variant(),
                    message.destination(),
                    message.recipient()
                )
            );

            // console.log(customHooks[hookKey][0]);

            require(
                customHooks[hookKey].length > 0,
                "DefaultHook: no hook specified"
            );
            hooksBuffer = hooksBuffer.push(customHooks[hookKey]);
        } else {
            console.log("No custom config");
            hooksBuffer.push(address(hooks[message.destination()]));
        }

        address nextHook;
        // striping metadata of default hook metadata
        bytes memory striped = metadata.striped();
        // loop through hooks until empty stack
        while (!hooksBuffer.isEmpty()) {
            (hooksBuffer, nextHook) = hooksBuffer.pop();
            address[] memory moreHooks = IPostDispatchHook(nextHook)
                .postDispatch{value: msg.value}(striped, message);
            hooksBuffer.push(moreHooks);
        }
        return new address[](1);
    }

    // restrict to first sender
    function configCustomHook(
        uint8 variant,
        uint32 destinationDomain,
        bytes32 recipient,
        address[] calldata hooks
    ) external {
        bytes32 hookKey = keccak256(
            abi.encodePacked(variant, destinationDomain, recipient)
        );
        customHooks[hookKey] = hooks;
    }
}
