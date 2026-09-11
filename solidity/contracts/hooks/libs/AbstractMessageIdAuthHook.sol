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
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "./AbstractPostDispatchHook.sol";
import {Message} from "../../libs/Message.sol";
import {StandardHookMetadata} from "./StandardHookMetadata.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

/**
 * @title AbstractMessageIdAuthHook
 * @notice Message hook to inform an Abstract Message ID ISM of messages published through
 * a third-party bridge.
 */
abstract contract AbstractMessageIdAuthHook is
    AbstractPostDispatchHook,
    MailboxClient
{
    using Address for address payable;
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // ============ Constants ============

    // left-padded address for ISM to verify messages
    bytes32 public immutable ism;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;

    // ============ Storage ============

    // `_isLatestDispatched` limits the replay window to the Mailbox's current
    // latest message ID. Once the Mailbox dispatches another message, the
    // previous ID can no longer pass that check. The checked Mailbox nonce also
    // makes every successive latest ID unique, so storing only the latest
    // successfully consumed ID prevents replay without an unbounded mapping.
    // Unstructured storage preserves external inheritor layouts.
    bytes32 private constant LAST_PROCESSED_MESSAGE_ID_SLOT =
        bytes32(
            uint256(
                keccak256(
                    "hyperlane.storage.AbstractMessageIdAuthHook.lastProcessedMessageId"
                )
            ) - 1
        );

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism
    ) MailboxClient(_mailbox) {
        require(_ism != bytes32(0), "AbstractMessageIdAuthHook: invalid ISM");
        require(
            _destinationDomain != 0,
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        ism = _ism;
        destinationDomain = _destinationDomain;
    }

    /// @inheritdoc AbstractPostDispatchHook
    /// @dev Bridge auth hooks charge fees in native tokens (via metadata.msgValue).
    /// Rejects metadata with a non-zero ERC20 fee token to prevent denomination
    /// mixing in Mailbox.quoteDispatch sums.
    function supportsMetadata(
        bytes calldata metadata
    ) public view override returns (bool) {
        if (metadata.feeToken(address(0)) != address(0)) {
            return false;
        }
        return super.supportsMetadata(metadata);
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure virtual returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.ID_AUTH_ISM);
    }

    // ============ Internal functions ============

    /// @inheritdoc AbstractPostDispatchHook
    // solhint-disable-next-line hyperlane/no-virtual-override
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual override {
        bytes32 id = message.id();

        _validateAndConsumeMessageId(id);
        require(
            message.destination() == destinationDomain,
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        require(
            metadata.msgValue(0) < 2 ** 255,
            "AbstractMessageIdAuthHook: msgValue must be less than 2 ** 255"
        );

        _sendMessageId(metadata, message);

        _refund(metadata, message, address(this).balance);
    }

    /// @dev Validates that the message is the Mailbox's latest dispatch and
    /// records it as consumed before the external bridge interaction.
    function _validateAndConsumeMessageId(bytes32 id) internal {
        require(
            _isLatestDispatched(id),
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        bytes32 lastProcessedMessageId = StorageSlot
            .getBytes32Slot(LAST_PROCESSED_MESSAGE_ID_SLOT)
            .value;
        require(
            id != lastProcessedMessageId,
            "AbstractMessageIdAuthHook: message already processed"
        );

        StorageSlot.getBytes32Slot(LAST_PROCESSED_MESSAGE_ID_SLOT).value = id;
    }

    /**
     * @notice Send a message to the ISM.
     * @param metadata The metadata for the hook caller
     * @param message The message to send to the ISM
     */
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual;
}
