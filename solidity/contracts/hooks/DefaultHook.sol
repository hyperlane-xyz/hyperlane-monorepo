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
import {DomainRoutingHook} from "./DomainRoutingHook.sol";

contract ConfigurableDomainRoutingHook is DomainRoutingHook {
    using Message for bytes;

    /// @notice mapping of destination domain and recipient to custom hook
    mapping(bytes32 => address) public customHooks;

    constructor(address mailbox, address owner)
        DomainRoutingHook(mailbox, owner)
    {}

    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
    {
        bytes32 hookKey = keccak256(
            abi.encodePacked(message.destination(), message.recipient())
        );

        address customHookPreset = customHooks[hookKey];
        if (customHookPreset != address(0)) {
            IPostDispatchHook(customHookPreset).postDispatch{value: msg.value}(
                metadata,
                message
            );
        } else {
            super._postDispatch(metadata, message);
        }
    }

    // TODO: need to restrict sender
    function configCustomHook(
        uint32 destinationDomain,
        bytes32 recipient,
        address hook
    ) external {
        bytes32 hookKey = keccak256(
            abi.encodePacked(destinationDomain, recipient)
        );
        require(customHooks[hookKey] == address(0), "hook already set");
        customHooks[hookKey] = hook;
    }
}
