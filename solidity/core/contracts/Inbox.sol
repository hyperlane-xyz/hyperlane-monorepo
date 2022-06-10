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
import {BN256} from "../libs/BN256.sol";

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
    using TypeCasts for bytes32;
    using MerkleLib for MerkleLib.Tree;
    using MerkleLib for MerkleLib.Proof;
    using Message for bytes;
    using BN256 for BN256.G1Point;

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
     */
    event Process(bytes32 indexed leaf);

    /**
     * @dev This event allows watchers to observe the merkle proof they need
     * to prove fraud on the Outbox.
     */
    event SignedCheckpoint(
        Checkpoint checkpoint,
        MerkleLib.Proof proof,
        uint256 signature,
        uint256 randomness,
        bytes32 nonce,
        bytes32[] missing
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
        Signature calldata _sig,
        Checkpoint calldata _checkpoint,
        MerkleLib.Proof[] calldata _proofs,
        bytes[] calldata _messages
    ) external override nonReentrant {
        bool _success = _verify(_sig, _checkpoint, remoteDomain);
        require(_success, "!sig");
        for (uint256 i = 0; i < _proofs.length; i++) {
            _process(_checkpoint, _proofs[i], _messages[i]);
            if (i == _proofs.length - 1) {
                emit SignedCheckpoint(
                    _checkpoint,
                    _proofs[i],
                    _sig.sig,
                    _sig.randomness,
                    _sig.nonce.compress(),
                    _sig.missing
                );
            } else {
                require(_proofs[i].index < _proofs[i + 1].index, "!ordered");
            }
        }
    }

    /**
     * @notice Attempts to process the provided formatted `message`. Performs
     * verification against root of the proof
     * @dev Called by the validator manager, which is responsible for verifying a
     * quorum of validator signatures on the checkpoint.
     * @dev Reverts if verification of the message fails.
     * @param _proof Merkle proof of inclusion for message's leaf
     * @param _message Formatted message (refer to Mailbox.sol Message library)
     */
    function process(
        Signature calldata _sig,
        Checkpoint calldata _checkpoint,
        MerkleLib.Proof calldata _proof,
        bytes calldata _message
    ) external override nonReentrant {
        bool _success = _verify(_sig, _checkpoint, remoteDomain);
        require(_success, "!sig");
        _process(_checkpoint, _proof, _message);
        // Missing compressed key, but maybe it's unnecessary?
        emit SignedCheckpoint(
            _checkpoint,
            _proof,
            _sig.sig,
            _sig.randomness,
            _sig.nonce.compress(),
            _sig.missing
        );
    }

    // ============ Internal Functions ============

    /**
     * @notice Marks a message as processed and calls handle on the recipient
     * @dev Internal function that can be called by contracts like TestInbox
     * @param _message Formatted message (refer to Mailbox.sol Message library)
     */
    function _process(
        Checkpoint calldata _checkpoint,
        MerkleLib.Proof calldata _proof,
        bytes calldata _message
    ) internal {
        require(_checkpoint.index >= _proof.index, "!index");
        //bytes32 _messageHash = _message.leaf(_leafIndex);
        require(keccak256(_message) == _proof.item, "!hash");
        require(
            messages[_proof.item] == MessageStatus.None,
            "!MessageStatus.None"
        );
        // calculate the expected root based on the proof
        require(_checkpoint.root == _proof.branchRoot(), "!proof");

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
        messages[_proof.item] = MessageStatus.Processed;

        IMessageRecipient(recipient.bytes32ToAddress()).handle(
            origin,
            sender,
            body
        );
        emit Process(_proof.item);
    }
}
