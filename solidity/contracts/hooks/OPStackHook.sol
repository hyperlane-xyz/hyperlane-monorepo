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
import {OPStackISM} from "../isms/hook/OPStackISM.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {OPStackHookMetadata} from "../libs/hooks/OPStackHookMetadata.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OPStackHook
 * @notice Message hook to inform the Optimism ISM of messages published through
 * the native OPStack bridge.
 * @dev V3 WIP
 */
contract OPStackHook is AbstractHook {
    using Message for bytes;
    using OPStackHookMetadata for bytes;
    using TypeCasts for address;

    // ============ Constants ============

    // Domain of chain on which the OPStack ISM is deployed
    uint32 public immutable destinationDomain;
    // Messenger used to send messages from L1 -> L2
    ICrossDomainMessenger public immutable l1Messenger;
    // address for OPStack ISM to verify messages
    address public immutable ism;
    // Gas limit for sending messages to L2
    // First 1.92e6 gas is provided by Optimism, see more here:
    // https://community.optimism.io/docs/developers/bridge/messaging/#for-l1-%E2%87%92-l2-transactions
    uint32 internal constant GAS_LIMIT = 1_920_000;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        address _messenger,
        address _ism
    ) AbstractHook(_mailbox) {
        require(
            _destinationDomain != 0,
            "OPStackHook: invalid destination domain"
        );
        require(_ism != address(0), "OPStackHook: invalid ISM");
        destinationDomain = _destinationDomain;

        require(
            Address.isContract(_messenger),
            "OPStackHook: invalid messenger"
        );
        l1Messenger = ICrossDomainMessenger(_messenger);
        ism = _ism;
    }

    // ============ External Functions ============

    /**
     * @notice Hook to inform the optimism ISM of messages published through.
     * metadata The metadata for the hook caller (unused)
     * @param message The message being dispatched
     */
    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
    {
        bytes32 messageId = message.id();
        uint256 msgValue = metadata.msgValue();

        require(
            message.destination() == destinationDomain,
            "OPStackHook: invalid destination domain"
        );

        bytes memory payload = abi.encodeCall(
            OPStackISM.verifyMessageId,
            (messageId)
        );

        // send the rest of the val
        l1Messenger.sendMessage{value: msgValue}(ism, payload, GAS_LIMIT);
    }
}
