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
import {GlobalHookMetadata} from "../libs/hooks/GlobalHookMetadata.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DomainRoutingHook is IPostDispatchHook, Ownable {
    using GlobalHookMetadata for bytes;
    using Message for bytes;

    struct HookConfig {
        uint32 destination;
        address hook;
    }

    // ============ Constants ============

    // The variant of the metadata used in the hook
    uint8 public constant METADATA_VARIANT = 1;

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

    function supportsMetadata(bytes calldata metadata)
        public
        pure
        override
        returns (bool)
    {
        return metadata.length == 0 || metadata.variant() == METADATA_VARIANT;
    }

    function postDispatch(bytes calldata metadata, bytes calldata message)
        public
        payable
        virtual
        override
    {
        require(
            supportsMetadata(metadata),
            "DomainRoutingHook: invalid metadata variant"
        );
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
        require(
            supportsMetadata(metadata),
            "DomainRoutingHook: invalid metadata variant"
        );
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
