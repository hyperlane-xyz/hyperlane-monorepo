// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Version0} from "./Version0.sol";
import {Common} from "./Common.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IInbox} from "../interfaces/IInbox.sol";

/**
 * @title Inbox
 * @author Celo Labs Inc.
 * @notice Track root updates on Outbox, prove and dispatch messages to end
 * recipients.
 */
contract Inbox is IInbox, Version0, Common {
    // ============ Libraries ============

    using Message for bytes;
    using TypeCasts for bytes32;

    // ============ Enums ============

    // Status of Message:
    //   0 - None - message has not been processed
    //   1 - Processed - message has been dispatched to recipient
    enum MessageStatus {
        None,
        Processed
    }

    // ============ Public Storage ============

    // Domain of outbox chain
    uint32 public override remoteDomain;
    // re-entrancy guard
    uint8 private entered;
    // Mapping of message leaves to MessageStatus
    mapping(bytes32 => MessageStatus) public messages;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when message is processed
     * @param messageHash Hash of message that failed to process
     */
    event Process(bytes32 indexed messageHash);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(uint32 _localDomain) Common(_localDomain) {}

    // ============ Initializer ============

    function initialize(uint32 _remoteDomain, address _validatorManager)
        public
        initializer
    {
        __Common_initialize(_validatorManager);
        entered = 1;
        remoteDomain = _remoteDomain;
    }

    // ============ External Functions ============

    // _process(bytes32 start, bytes32[] digests, bytes signature, bytes message)
    function processInefficient(
        bytes calldata _message,
        bytes32 _baseCommitment,
        bytes32 _commitment,
        bytes32[] calldata _messageHashes,
        uint256 _index,
        bytes calldata /* _sovereignData */
    ) external {
        // check re-entrancy guard
        require(entered == 1, "!reentrant");
        entered = 0;

        bytes32 _messageHash = keccak256(_message);
        require(_messageHashes[_index] == _messageHash, "!msgHash");
        bytes32 acc = _baseCommitment;
        bytes32 _messageCommitment;
        for (uint256 i = 0; i < _messageHashes.length; i++) {
            acc = keccak256(abi.encodePacked(acc, _messageHashes[i]));
            // We need to find the commitment to the message so that we can
            // prevent replays. Alternatively, we could encode a nonce in the message
            // for uniqueness.
            if (i == _index) {
                _messageCommitment = acc;
            }
        }
        require(acc == _commitment, "!_commitment"); 

        // ensure that message has not been processed
        require(
            messages[_messageCommitment] == MessageStatus.None,
            "!MessageStatus.None"
        );
        _process(_message, _messageCommitment);
        // reset re-entrancy guard
        entered = 1;
    }
    /**
    * @notice Attempts to process the provided formatted `message`. Performs
    * verification against root of the proof
    * @dev Reverts if verification of the message fails.
    * @dev Includes the eventual function signature for Sovereign Consensus,
    * but comments out the name to suppress compiler warning
    * @param _message Formatted message (refer to Common.sol Message library)
    */
// _process(bytes32 start, bytes32[] digests, bytes signature, bytes message)
// process(bytes32 start, bytes message, bytes signature)
function process(
    bytes calldata _message,
    bytes32 _baseCommitment,
    bytes32 _commitment,
    bytes calldata /* _sovereignData */
) external override {
    // check re-entrancy guard
    require(entered == 1, "!reentrant");
    entered = 0;

        // ensure the provided message and base commitment result in _commitment, which
        // was signed by the validator set.
        bytes32 _messageHash = keccak256(_message);
        require(
            keccak256(abi.encodePacked(_baseCommitment, _messageHash)) ==
                _commitment,
            "!commitment"
        );
        // ensure that message has not been processed
        require(
            messages[_commitment] == MessageStatus.None,
            "!MessageStatus.None"
        );
        _process(_message, _commitment);
        // reset re-entrancy guard
        entered = 1;
    }

    // ============ Internal Functions ============

    /**
     * @notice Marks a message as processed and calls handle on the recipient
     * @dev Internal function that can be called by contracts like TestInbox
     * @param _message Formatted message (refer to Common.sol Message library)
     */
    function _process(bytes calldata _message, bytes32 _commitment) internal {
        (
            uint32 origin,
            bytes32 sender,
            uint32 destination,
            bytes32 recipient,
            bytes calldata body
        ) = _message.destructure();

        // ensure message was meant for this domain
        require(destination == localDomain, "!destination");

        // update message status as processed
        messages[_commitment] = MessageStatus.Processed;

        IMessageRecipient(recipient.bytes32ToAddress()).handle(
            origin,
            sender,
            body
        );
        // emit process results
        emit Process(_commitment);
    }
}
