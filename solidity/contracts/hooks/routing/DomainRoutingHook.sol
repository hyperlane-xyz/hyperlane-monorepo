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
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";
import {Message} from "../../libs/Message.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title DomainRoutingHook
 * @notice Delegates to a hook based on the destination domain of the message.
 */
contract DomainRoutingHook is AbstractPostDispatchHook, MailboxClient {
    using Strings for uint32;
    using Message for bytes;

    struct HookConfig {
        uint32 destination;
        address hook;
    }

    mapping(uint32 destinationDomain => IPostDispatchHook hook) public hooks;

    constructor(address _mailbox, address _owner) MailboxClient(_mailbox) {
        _transferOwnership(_owner);
    }

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure virtual override returns (uint8) {
        return uint8(IPostDispatchHook.Types.ROUTING);
    }

    function setHook(uint32 _destination, address _hook) public onlyOwner {
        hooks[_destination] = IPostDispatchHook(_hook);
    }

    function setHooks(HookConfig[] calldata configs) external onlyOwner {
        for (uint256 i = 0; i < configs.length; i++) {
            setHook(configs[i].destination, configs[i].hook);
        }
    }

    function supportsMetadata(
        bytes calldata
    ) public pure virtual override returns (bool) {
        // routing hook does not care about metadata shape
        return true;
    }

    // ============ Internal Functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual override {
        _getConfiguredHook(message).postDispatch{value: msg.value}(
            metadata,
            message
        );
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual override returns (uint256) {
        return _getConfiguredHook(message).quoteDispatch(metadata, message);
    }

    function _getConfiguredHook(
        bytes calldata message
    ) internal view virtual returns (IPostDispatchHook hook) {
        hook = hooks[message.destination()];
        if (address(hook) == address(0)) {
            revert(
                string.concat(
                    "No hook configured for destination: ",
                    message.destination().toString()
                )
            );
        }
    }
}
