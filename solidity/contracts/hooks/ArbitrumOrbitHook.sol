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
import {IGasOracle} from "../interfaces/IGasOracle.sol";

// ========= External Imports ============
import {IInbox, IBridge} from "@arbitrum/nitro-contracts/src/bridge/Inbox.sol";
import {IOutbox} from "@arbitrum/nitro-contracts/src/bridge/Outbox.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @notice This object is meant to be used in an Aribtrum L1->L2 message passing.
/// As an example, Hyperlane user interested in passing a message from Ethereum Mainnet to Arbitrum One calls the Mailbox on Ethereum Mainnet which calls this object.
/// Ultimately, this causes the message ID to be marked as verified on the L2 ISM so a relayer can relay the message.
/// The terms L1 and L2 used here to mean the source and destination chain, so L1->L2 can refer to L1->L2, L2->L3, L3->L4 and so on.
/// You can find an introduction to Hyperlane's message passing at https://docs.hyperlane.xyz/docs/reference/messaging/messaging-interface.
/// @notice When the Mailbox calls this object, the mechanism to realize L1->L2 message passing is through Arbitrum's retryables.
/// At a high level, when Mailbox calls this object, this object creates a retryable,
/// Then Arbitrum **strongly guarantees the retryable will eventually be executed successfully**.
/// You can find retryable docs and its lifecycle at https://docs.arbitrum.io/arbos/l1-to-l2-messaging#submission.
/// @dev This object is meant to be called as custom hook. So as an end user, you will want to
/// give this object's address as custom hook when calling the Mailbox.
/// Docs: https://docs.hyperlane.xyz/docs/reference/hooks/overview#custom-hook-and-metadata.
contract ArbitrumOrbitHook is AbstractMessageIdAuthHook {
    using Message for bytes;
    using StandardHookMetadata for bytes;

    IInbox public immutable l1Inbox;
    IGasOracle public immutable gasOracle;

    /// @dev See StandardHookMetadata.sol
    uint256 private constant CUSTOM_METADATA_OFFSET = 86;

    event RetryableTicketCreated(uint256 indexed ticketId);

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _l1Inbox,
        address _gasOracle
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        require(Address.isContract(_l1Inbox), "ArbitrumHook: invalid inbox");
        l1Inbox = IInbox(_l1Inbox);
        gasOracle = IGasOracle(_gasOracle);
    }

    /**
     * @notice Send a message to the ISM.
     * @dev This is ultimately called from postDispatch in IPostDispatchHook.
     * @param metadata Docs: https://docs.hyperlane.xyz/docs/reference/hooks/overview#custom-hook-and-metadata
     * metadata format:
     * [0:2] variant (meaning the 0th to 2nd byte is the variant)
     * [2:34] msg.value
     * [34:66] Gas limit for message
     * [66:86] Refund address for message
     * [86:117] Optional max fee per gas (this is custom metadata)
     * @param payload The payload for call to the ISM.
     */
    function _sendMessageId(
        bytes calldata metadata,
        bytes memory payload
    ) internal override {
        address refundAddress = metadata.refundAddress(address(0));
        l1Inbox.createRetryableTicket{value: msg.value}(
            TypeCasts.bytes32ToAddress(ism),
            metadata.msgValue(0),
            _submissionFee(),
            refundAddress,
            refundAddress,
            metadata.gasLimit(0),
            _maxFeePerGas(metadata),
            payload
        );
    }

    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata
    ) internal view override returns (uint256 quote) {
        quote =
            metadata.msgValue(0) +
            metadata.gasLimit(0) *
            _maxFeePerGas(metadata) +
            _submissionFee();
    }

    /// @notice Get submission fee for creating an Arbitrum retryable ticket
    function _submissionFee() private view returns (uint256 fee) {
        // See IInboxBase.sol for details.
        // 1st param dataLength: 36 bytes is always 36 bytes because the data is always the verifyMessageId calldata to the ISM.
        // The calldata has 4 bytes for method ID and 32 bytes for message ID.
        // 2nd param block base assumption: 0 wei means block.basefee is used.
        // See AbstractMessageIdAuthHook.sol::_postDispatch for payload length.
        fee = l1Inbox.calculateRetryableSubmissionFee(36, 0);
    }

    function _maxFeePerGas(
        bytes calldata metadata
    ) private view returns (uint256 maxFeePerGas) {
        if (metadata.length >= CUSTOM_METADATA_OFFSET + 1) {
            // If use provided max fee per gas
            maxFeePerGas = abi.decode(metadata.getCustomMetadata(), (uint256));
        } else {
            // Else use oracleized gas price
            (, uint128 maxGasPriceU128) = gasOracle.getExchangeRateAndGasPrice(
                destinationDomain
            );
            maxFeePerGas = maxGasPriceU128;
        }
    }
}
