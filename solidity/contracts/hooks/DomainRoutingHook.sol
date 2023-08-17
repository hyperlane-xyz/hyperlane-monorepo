// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DomainRoutingHook is IPostDispatchHook, Ownable {
    using Message for bytes;

    struct HookConfig {
        uint32 destination;
        address hook;
    }

    mapping(uint32 => IPostDispatchHook) public hooks;

    constructor(address _owner) {
        _transferOwnership(_owner);
    }

    function setHook(uint32 destination, address hook) public onlyOwner {
        hooks[destination] = IPostDispatchHook(hook);
    }

    function setHooks(HookConfig[] calldata configs) external onlyOwner {
        for (uint256 i = 0; i < configs.length; i++) {
            setHook(configs[i].destination, configs[i].hook);
        }
    }

    function postDispatch(bytes calldata metadata, bytes calldata message)
        public
        payable
        virtual
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
        virtual
        override
        returns (uint256)
    {
        return _getConfiguredHook(message).quoteDispatch(metadata, message);
    }

    // ============ Internal Functions ============

    function _getConfiguredHook(bytes calldata message)
        internal
        view
        returns (IPostDispatchHook)
    {
        return hooks[message.destination()];
    }
}
