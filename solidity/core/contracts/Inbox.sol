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
     * @notice Attempts to process the provided formatted `message`. Performs
     * verification against root of the proof
     * @dev Reverts if verification of the message fails.
     * @dev Includes the eventual function signature for Sovereign Consensus,
     * but comments out the name to suppress compiler warning
     * @param _message Formatted message (refer to Common.sol Message library)
     * @param _proof Merkle proof of inclusion for message's leaf
     * @param _index Index of leaf in outbox's merkle tree
     */
    function process(
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _index,
        bytes calldata /* _sovereignData */
    ) external override {
        // check re-entrancy guard
        require(entered == 1, "!reentrant");
        entered = 0;

        bytes32 _leaf = keccak256(_message);
        // ensure that message has not been processed
        require(messages[_leaf] == MessageStatus.None, "!MessageStatus.None");
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(_leaf, _proof, _index);
        // ensure that the root has been checkpointed
        require(checkpoints[_calculatedRoot] > 0, "!checkpointed root");
        _process(_message);
        // reset re-entrancy guard
        entered = 1;
    }

    // ============ Internal Functions  ============

    /**
     * @notice Internal function that can be called by contracts like TestInbox
     * @param _message Formatted message (refer to Common.sol Message library)
     */
    function _process(bytes calldata _message) internal {
        bytes29 _m = _message.ref(0);
        // ensure message was meant for this domain
        require(_m.destination() == localDomain, "!destination");

        bytes32 _messageHash = _m.keccak();
        // update message status as processed
        messages[_messageHash] = MessageStatus.Processed;
        IMessageRecipient _recipient = IMessageRecipient(_m.recipientAddress());
        _recipient.handle(_m.origin(), _m.sender(), _m.body().clone());
        // emit process results
        emit Process(_messageHash);
    }
}
