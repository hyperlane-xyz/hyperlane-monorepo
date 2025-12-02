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

import {Message} from "../../libs/Message.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {DomainRoutingHook} from "./DomainRoutingHook.sol";

contract DestinationRecipientRoutingHook is DomainRoutingHook {
    using Message for bytes;

    /// @notice destination => recipient => custom hook
    mapping(uint32 destinationDomain => mapping(bytes32 recipient => address hook))
        public customHooks;

    constructor(
        address mailbox,
        address owner
    ) DomainRoutingHook(mailbox, owner) {}

    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        address customHookPreset = customHooks[message.destination()][
            message.recipient()
        ];
        if (customHookPreset != address(0)) {
            IPostDispatchHook(customHookPreset).postDispatch{value: msg.value}(
                metadata,
                message
            );
        } else {
            super._postDispatch(metadata, message);
        }
    }

    function configCustomHook(
        uint32 destinationDomain,
        bytes32 recipient,
        address hook
    ) external onlyOwner {
        customHooks[destinationDomain][recipient] = hook;
    }
}
