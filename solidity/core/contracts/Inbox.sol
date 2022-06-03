// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Version0} from "./Version0.sol";
import {Mailbox} from "./Mailbox.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IInbox} from "../interfaces/IInbox.sol";

// ============ External Imports ============
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

/**
 * @title Inbox
 * @author Celo Labs Inc.
 * @notice Track root updates on Outbox, prove and dispatch messages to end
 * recipients.
 */
contract Inbox is IInbox, ReentrancyGuardUpgradeable, Version0, Mailbox {
    // ============ Libraries ============

    using MerkleLib for MerkleLib.Tree;
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
    // Mapping of message leaves to MessageStatus
    mapping(bytes32 => MessageStatus) public messages;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[48] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when message is processed
     * @dev This event allows watchers to observe the merkle proof they need
     * to prove fraud on the Outbox.
     * @param messageHash Hash of message that was processed.
     * @param leafIndex The leaf index of the message that was processed.
     * @param proof A merkle proof of inclusion of `messageHash` at `leafIndex`.
     */
    event Process(
        bytes32 indexed messageHash,
        uint256 indexed leafIndex,
        bytes32[32] proof
    );

    event BatchProcess(
        bytes32 indexed messageHash,
        bytes32[32] indexed proof,
        uint256[] indexed leafIndices
    );

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(uint32 _localDomain) Mailbox(_localDomain) {}

    // ============ Initializer ============

    function initialize(uint32 _remoteDomain, address _validatorManager)
        public
        initializer
    {
        __ReentrancyGuard_init();
        __Mailbox_initialize(_validatorManager);
        remoteDomain = _remoteDomain;
    }

    // ============ External Functions ============
    /**
     * @notice Attempts to process the provided formatted `message`. Performs
     * verification against root of the proof
     * @dev Reverts if verification of the message fails.
     * @dev Includes the eventual function signature for Sovereign Consensus,
     * but comments out the name to suppress compiler warning
     */
    function batchProcess(
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _messages,
        bytes32[32][] calldata _proofs,
        uint256[] calldata _leafIndices
    ) external nonReentrant onlyValidatorManager {
        for (uint256 i = 0; i < _leafIndices.length; i++) {
            require(_index >= _leafIndices[i], "!index");
            //bytes32 _messageHash = _message.leaf(_leafIndex);
            bytes32 _messageHash = keccak256(_messages[i]);
            // ensure that message has not been processed
            require(
                messages[_messageHash] == MessageStatus.None,
                "!MessageStatus.None"
            );
            // calculate the expected root based on the proof
            bytes32 _calculatedRoot = MerkleLib.branchRoot(
                _messageHash,
                _proofs[i],
                _leafIndices[i]
            );
            require(_calculatedRoot == _root, "!proof");
            _process(_messages[i], _messageHash);
            if (i == _leafIndices.length - 1) {
                emit BatchProcess(_messageHash, _proofs[i], _leafIndices);
            } else {
                require(_leafIndices[i] < _leafIndices[i + 1], "!ordered");
            }
        }
    }

    /**
     * @notice Attempts to process the provided formatted `message`. Performs
     * verification against root of the proof
     * @dev Called by the validator manager, which is responsible for verifying a
     * quorum of validator signatures on the checkpoint.
     * @dev Reverts if verification of the message fails.
     * @param _root The merkle root of the checkpoint used to prove message inclusion.
     * @param _index The index of the checkpoint used to prove message inclusion.
     * @param _message Formatted message (refer to Mailbox.sol Message library)
     * @param _proof Merkle proof of inclusion for message's leaf
     * @param _leafIndex Index of leaf in outbox's merkle tree
     */
    function process(
        bytes32 _root,
        uint256 _index,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external override nonReentrant onlyValidatorManager {
        require(_index >= _leafIndex, "!index");
        //bytes32 _messageHash = _message.leaf(_leafIndex);
        bytes32 _messageHash = keccak256(_message);
        // ensure that message has not been processed
        require(
            messages[_messageHash] == MessageStatus.None,
            "!MessageStatus.None"
        );
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(
            _messageHash,
            _proof,
            _leafIndex
        );
        require(_calculatedRoot == _root, "!proof");
        _process(_message, _messageHash);
        emit Process(_messageHash, _leafIndex, _proof);
    }

    // ============ Internal Functions ============

    /**
     * @notice Marks a message as processed and calls handle on the recipient
     * @dev Internal function that can be called by contracts like TestInbox
     * @param _message Formatted message (refer to Mailbox.sol Message library)
     * @param _messageHash keccak256 hash of the message
     */
    function _process(bytes calldata _message, bytes32 _messageHash) internal {
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
        messages[_messageHash] = MessageStatus.Processed;

        IMessageRecipient(recipient.bytes32ToAddress()).handle(
            origin,
            sender,
            body
        );
    }
}
