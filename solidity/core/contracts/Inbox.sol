// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {Version0} from "./Version0.sol";
import {Common} from "./Common.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IInbox} from "../interfaces/IInbox.sol";
// ============ External Imports ============
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";

/**
 * @title Inbox
 * @author Celo Labs Inc.
 * @notice Track root updates on Outbox, prove and dispatch messages to end
 * recipients.
 */
contract Inbox is IInbox, Version0, Common {
    // ============ Libraries ============

    using MerkleLib for MerkleLib.Tree;
    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using Message for bytes29;

    // ============ Enums ============

    // Status of Message:
    //   0 - None - message has not been proven or processed
    //   1 - Proven - message inclusion proof has been validated
    //   2 - Processed - message has been dispatched to recipient
    enum MessageStatus {
        None,
        Proven,
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

    function initialize(
        uint32 _remoteDomain,
        address _validatorManager,
        bytes32 _checkpointedRoot,
        uint256 _checkpointedIndex
    ) public initializer {
        __Common_initialize(_validatorManager);
        entered = 1;
        remoteDomain = _remoteDomain;
        _checkpoint(_checkpointedRoot, _checkpointedIndex);
    }

    // ============ External Functions ============

    /**
     * @notice Checkpoints the provided root and index given a signature.
     * @dev Reverts if checkpoints's index is not greater than our latest index.
     * @param _root Checkpoint's merkle root
     * @param _index Checkpoint's index
     * @param _signature Validator's signature on `_root` and `_index`
     */
    function checkpoint(
        bytes32 _root,
        uint256 _index,
        bytes calldata _signature
    ) external override {
        // ensure that update is more recent than the latest we've seen
        require(_index > checkpoints[checkpointedRoot], "old checkpoint");
        // validate validator signature
        require(
            validatorManager.isValidatorSignature(
                remoteDomain,
                _root,
                _index,
                _signature
            ),
            "!validator sig"
        );
        _checkpoint(_root, _index);
    }

    /**
     * @notice First attempts to prove the validity of provided formatted
     * `message`. If the message is successfully proven, then tries to process
     * message.
     * @dev Reverts if `prove` call returns false
     * @param _message Formatted message (refer to Common.sol Message library)
     * @param _proof Merkle proof of inclusion for message's leaf
     * @param _index Index of leaf in outbox's merkle tree
     */
    function proveAndProcess(
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _index
    ) external override {
        require(prove(keccak256(_message), _proof, _index), "!prove");
        process(_message);
    }

    // ============ Public Functions ============

    /**
     * @notice Given formatted message, attempts to dispatch
     * message payload to end recipient.
     * @dev Recipient must implement a `handle` method (refer to IMessageRecipient.sol)
     * Reverts if formatted message's destination domain is not the Inbox's domain,
     * if message has not been proven, or if the dispatch transaction fails.
     * @param _message Formatted message
     */
    function process(bytes calldata _message) public {
        bytes29 _m = _message.ref(0);
        // ensure message was meant for this domain
        require(_m.destination() == localDomain, "!destination");
        // ensure message has been proven
        bytes32 _messageHash = _m.keccak();
        require(messages[_messageHash] == MessageStatus.Proven, "!proven");
        // check re-entrancy guard
        require(entered == 1, "!reentrant");
        entered = 0;
        // update message status as processed
        messages[_messageHash] = MessageStatus.Processed;
        IMessageRecipient _recipient = IMessageRecipient(_m.recipientAddress());
        _recipient.handle(_m.origin(), _m.sender(), _m.body().clone());
        // emit process results
        emit Process(_messageHash);
        // reset re-entrancy guard
        entered = 1;
    }

    /**
     * @notice Attempts to prove the validity of message given its leaf, the
     * merkle proof of inclusion for the leaf, and the index of the leaf.
     * @dev Reverts if message's MessageStatus != None (i.e. if message was
     * already proven or processed)
     * @dev For convenience, we allow proving against any previous root.
     * This means that witnesses never need to be updated for the new root
     * @param _leaf Leaf of message to prove
     * @param _proof Merkle proof of inclusion for leaf
     * @param _index Index of leaf in outbox's merkle tree
     * @return Returns true if proof was valid and `prove` call succeeded
     **/
    function prove(
        bytes32 _leaf,
        bytes32[32] calldata _proof,
        uint256 _index
    ) public returns (bool) {
        // ensure that message has not been proven or processed
        require(messages[_leaf] == MessageStatus.None, "!MessageStatus.None");
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(_leaf, _proof, _index);
        // if the root is valid, change status to Proven
        if (checkpoints[_calculatedRoot] > 0) {
            messages[_leaf] = MessageStatus.Proven;
            return true;
        }
        return false;
    }
}
