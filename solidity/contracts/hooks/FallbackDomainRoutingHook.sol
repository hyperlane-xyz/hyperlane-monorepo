// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DomainRoutingHook is IPostDispatchHook, MailboxClient, Ownable {
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

    /**
     * @notice Dispatches a message to the destination domain with fallback to the default hook.
     * @param metadata The metadata for the message.
     * @param message The message to dispatch.
     */
    function postDispatch(bytes calldata metadata, bytes calldata message)
        public
        payable
        virtual
        override
    {
        try
            hooks[message.destination()].postDispatch{value: msg.value}(
                metadata,
                message
            )
        {} catch {
            mailbox.defaultHook().postDispatch(metadata, message);
        }
    }
}
