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
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @title DomainRecipientRoutingHook
 * @notice Delegates to a hook based on both the destination domain and recipient of the message.
 * @dev Uses a composite key of domain and recipient to route messages to specific hooks.
 */
contract DomainRecipientRoutingHook is AbstractPostDispatchHook, MailboxClient {
    using Strings for uint32;
    using Message for bytes;
    using TypeCasts for bytes32;

    struct HookConfig {
        uint32 destination;
        address recipient;
        address hook;
    }

    // Mapping of domain and recipient to hook
    mapping(uint32 => mapping(address => IPostDispatchHook)) public hooks;

    constructor(address _mailbox, address _owner) MailboxClient(_mailbox) {
        _transferOwnership(_owner);
    }

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure virtual override returns (uint8) {
        return uint8(IPostDispatchHook.Types.ROUTING);
    }

    /**
     * @notice Sets a hook for a specific domain and recipient combination
     * @param _destination The destination domain
     * @param _recipient The recipient address
     * @param _hook The hook address to use
     */
    function setHook(
        uint32 _destination,
        address _recipient,
        address _hook
    ) public onlyOwner {
        hooks[_destination][_recipient] = IPostDispatchHook(_hook);
    }

    /**
     * @notice Sets multiple hooks at once
     * @param configs Array of hook configurations
     */
    function setHooks(HookConfig[] calldata configs) external onlyOwner {
        for (uint256 i = 0; i < configs.length; i++) {
            setHook(
                configs[i].destination,
                configs[i].recipient,
                configs[i].hook
            );
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
        uint32 destination = message.destination();
        address recipient = message.recipient().bytes32ToAddress();

        hook = hooks[destination][recipient];
        if (address(hook) == address(0)) {
            revert(
                string.concat(
                    "No hook configured for destination: ",
                    destination.toString(),
                    " and recipient: ",
                    Strings.toHexString(uint160(recipient), 20)
                )
            );
        }
    }
}
