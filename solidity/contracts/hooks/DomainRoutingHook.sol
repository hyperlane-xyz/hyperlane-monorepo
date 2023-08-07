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

    function setHooks(uint32[] memory destinations, address[] memory _hooks)
        external
        onlyOwner
    {
        for (uint256 i = 0; i < destinations.length; i++) {
            hooks[destinations[i]] = IPostDispatchHook(_hooks[i]);
        }
    }

    function _postDispatch(
        bytes calldata, /*metadata*/
        bytes calldata message
    ) internal virtual override returns (address[] memory) {
        // check metadata
        address[] memory result = new address[](1);
        result[0] = address(hooks[message.destination()]);
        return result;
    }
}
