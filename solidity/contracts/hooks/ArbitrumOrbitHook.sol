// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.0;

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
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {AbstractMessageIdAuthorizedIsm} from "../isms/hook/AbstractMessageIdAuthorizedIsm.sol";

// ========= External Imports ============
import {IInbox, IBridge} from "@arbitrum/nitro-contracts/src/bridge/Inbox.sol";
import {IOutbox} from "@arbitrum/nitro-contracts/src/bridge/Outbox.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @dev Documentation for `calculateRetryableSubmissionFee`: https://docs.arbitrum.io/arbos/l1-to-l2-messaging#submission
/// @dev When making a `dispatch` call, you will need to specify parameters in `metadata`, specifically:
/// * `uint256 l2CallValue`: The callvalue for retryable L2 message that is supplied within the deposit (l1CallValue)
/// * `uint256 gasLimit`: Maximum amount of gas used to cover L2 execution of the ticket
/// * `uint256 maxFeePerGas` (as custom metadata): The gas price bid for L2 execution of the ticket that is supplied within the deposit (l1CallValue)
/// See the `createRetryableTicket` call below or ArbitrumDispatcher.s.sol for detail.
contract ArbitrumOrbitHook is AbstractMessageIdAuthHook {
    using Message for bytes;
    using StandardHookMetadata for bytes;

    /// Arbitrum's inbox contract object.
    IInbox public immutable baseInbox;

    /// @dev Copied from StandardHookMetadata.sol.
    uint256 private constant MIN_METADATA_LENGTH = 86;
    /// @dev See AbstractMessageIdAuthHook.sol::_postDispatch for payload length.
    uint256 private constant PAYLOAD_LENGTH = 36;

    event RetryableTicketCreated(uint256 indexed ticketId);

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _baseInbox
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        require(Address.isContract(_baseInbox), "ArbitrumHook: invalid inbox");
        baseInbox = IInbox(_baseInbox);
    }

    /**
     * @notice Send a message to the ISM.
     * @param metadata The metadata from the hook caller.
     * metadata format:
     * [0:2] variant
     * [2:34] msg.value
     * [34:66] Gas limit for message
     * [66:86] Refund address for message
     * [86:117] Max fee per gas (custom)
     * @param payload The payload for call to the ISM.
     */
    function _sendMessageId(
        bytes calldata metadata,
        bytes memory payload
    ) internal override {
        // Note AbstractMessageIdAuthorizationIsm's `verifiedMessages` stores each message's verification bit
        // and msg.value together in the same slot, so msg.value has to be less than 2 ** 255.
        require(
            metadata.msgValue(0) < 2 ** 255,
            "ArbitrumOrbitHook: msgValue must be less than 2 ** 255"
        );
        // To make sure the default value for each meta datum IS NOT used.
        require(
            metadata.length >= MIN_METADATA_LENGTH,
            "ArbitrumOrbitHook: invalid metadata length"
        );

        address refundAddress = metadata.refundAddress(address(0));
        uint256 ticketID = baseInbox.createRetryableTicket{value: msg.value}(
            TypeCasts.bytes32ToAddress(ism),
            metadata.msgValue(0),
            baseInbox.calculateRetryableSubmissionFee(PAYLOAD_LENGTH, 0),
            refundAddress,
            refundAddress,
            metadata.gasLimit(0),
            abi.decode(metadata.getCustomMetadata(), (uint256)),
            payload
        );
        emit RetryableTicketCreated(ticketID);
    }

    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata
    ) internal view override returns (uint256) {
        uint256 maxFeePerGas = abi.decode(
            metadata.getCustomMetadata(),
            (uint256)
        );
        uint256 maxSubmissionCost = baseInbox.calculateRetryableSubmissionFee(
            PAYLOAD_LENGTH,
            0
        );
        return
            metadata.msgValue(0) +
            metadata.gasLimit(0) *
            maxFeePerGas +
            maxSubmissionCost;
    }
}
