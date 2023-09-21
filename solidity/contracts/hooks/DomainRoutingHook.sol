// SPDX-License-Identifier: MIT
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

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";
import {StandardHookMetadata} from "../libs/hooks/StandardHookMetadata.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "./AbstractPostDispatchHook.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DomainRoutingHook is AbstractPostDispatchHook, MailboxClient, Ownable {
    using StandardHookMetadata for bytes;
    using Message for bytes;

    struct HookConfig {
        uint32 destination;
        address hook;
    }

    mapping(uint32 => IPostDispatchHook) public hooks;

    constructor(address _mailbox, address _owner) MailboxClient(_mailbox) {
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

    // ============ Internal Functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        virtual
        override
    {
        _getConfiguredHook(message).postDispatch{value: msg.value}(
            metadata,
            message
        );
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(bytes calldata metadata, bytes calldata message)
        internal
        view
        virtual
        override
        returns (uint256)
    {
        return _getConfiguredHook(message).quoteDispatch(metadata, message);
    }

    function _getConfiguredHook(bytes calldata message)
        internal
        view
        returns (IPostDispatchHook)
    {
        return hooks[message.destination()];
    }
}
