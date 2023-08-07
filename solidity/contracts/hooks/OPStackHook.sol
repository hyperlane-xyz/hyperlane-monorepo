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

import "forge-std/console.sol";

// ============ Internal Imports ============
import {AbstractHook} from "./AbstractHook.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {OPStackHookMetadata} from "../libs/hooks/OPStackHookMetadata.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {OPStackIsm} from "../isms/hook/OPStackIsm.sol";

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
    using Address for address payable;
    using OPStackHookMetadata for bytes;
    using Message for bytes;

    // ============ Constants ============

    ICrossDomainMessenger public immutable l1Messenger;
    // address for ISM to verify messages
    address public immutable ism;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;
    // Gas limit for sending messages to L2
    // First 1.92e6 gas is provided by Optimism, see more here:
    // https://community.optimism.io/docs/developers/bridge/messaging/#for-l1-%E2%87%92-l2-transactions
    uint32 internal constant GAS_LIMIT = 1_920_000;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        address _ism,
        address _messenger
    ) AbstractHook(_mailbox) {
        require(_ism != address(0), "OPStackHook: invalid ISM");
        require(
            _destinationDomain != 0,
            "OPStackHook: invalid destination domain"
        );
        require(
            Address.isContract(_messenger),
            "OPStackHook: invalid messenger"
        );

        l1Messenger = ICrossDomainMessenger(_messenger);
        ism = _ism;
        destinationDomain = _destinationDomain;
    }

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
            OPStackIsm.verifyMessageId,
            (message.id(), payable(message.recipientAddress()))
        );
        l1Messenger.sendMessage{value: metadata.msgValue()}(
            ism,
            payload,
            GAS_LIMIT
        );

        // refund unused msgvalue
        payable(message.senderAddress()).sendValue(
            msg.value - metadata.msgValue()
        );

        // leaf hook
        return new address[](0);
    }
}
