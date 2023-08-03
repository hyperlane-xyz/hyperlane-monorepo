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

// ============ Internal Imports ============
import {AbstractHook} from "./AbstractHook.sol";
import {AbstractMessageIdAuthorizedIsm} from "../isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {OPStackHookMetadata} from "../libs/hooks/OPStackHookMetadata.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title AbstractMessageIdAuthHook
 * @notice Message hook to inform an Abstract Message ID ISM of messages published through
 * the third-party bridge.
 * @dev V3 WIP
 */
abstract contract AbstractMessageIdAuthHook is AbstractHook {
    using Message for bytes;

    // ============ Constants ============

    // address for ISM to verify messages
    address public immutable ism;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        address _ism
    ) AbstractHook(_mailbox) {
        require(_ism != address(0), "invalid ISM");
        require(_destinationDomain != 0, "invalid destination domain");
        ism = _ism;
        destinationDomain = _destinationDomain;
    }

    function _sendMessageId(bytes calldata metadata, bytes memory payload)
        internal
        virtual;

    /**
     * @notice Hook to inform the optimism ISM of messages published through.
     * metadata The metadata for the hook caller
     * @param message The message being dispatched
     */
    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
        returns (address[] memory)
    {
        require(
            message.destination() == destinationDomain,
            "invalid destination domain"
        );

        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            message.id()
        );
        _sendMessageId(metadata, payload);

        // leaf hook
        return new address[](0);
    }
}
