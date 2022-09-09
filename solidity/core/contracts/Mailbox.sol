// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Versioned} from "./upgrade/Versioned.sol";
import {MerkleLib} from "./libs/Merkle.sol";
import {Message} from "./libs/Message.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";
import {ISovereignRecipient} from "../interfaces/ISovereignRecipient.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {ISovereignZone} from "../interfaces/ISovereignZone.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";

// ============ External Imports ============
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

contract Mailbox is IMailbox, ReentrancyGuardUpgradeable, Versioned {
    // ============ Libraries ============

    using MerkleLib for MerkleLib.Tree;
    using Message for bytes;
    using TypeCasts for bytes32;
    using TypeCasts for address;

    // ============ Constants ============

    // Maximum bytes per message = 2 KiB
    // (somewhat arbitrarily set to begin)
    uint256 public constant MAX_MESSAGE_BODY_BYTES = 2 * 2**10;
    // Domain of chain on which the contract is deployed
    uint32 public immutable localDomain;

    // ============ Enums ============

    // Status of Message:
    //   0 - None - message has not been processed
    //   1 - Processed - message has been dispatched to recipient
    enum MessageStatus {
        None,
        Processed
    }

    // ============ Public Storage ============
    ISovereignZone public defaultZone;
    MerkleLib.Tree public tree;

    // Mapping of message leaves to MessageStatus
    mapping(bytes32 => MessageStatus) public messages;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a new message is dispatched via Abacus
     * @param leafIndex Index of message's leaf in merkle tree
     * @param message Raw bytes of message
     */
    event Dispatch(uint256 indexed leafIndex, bytes message);

    /**
     * @notice Emitted when message is processed
     * @dev This event allows watchers to observe the merkle proof they need
     * to prove fraud on the origin chain.
     */
    event Process(
        bytes32 indexed messageHash,
        bytes32 root,
        bytes32[32] proof,
        uint32 originDomain,
        bytes32 originMailbox
    );

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    // ============ Initializer ============

    function initialize(address _defaultZone) external initializer {
        __ReentrancyGuard_init();
        // TODO: setDefaultSovereignZone, check for isContract.
        defaultZone = ISovereignZone(_defaultZone);
    }

    // ============ External Functions ============

    /**
     * @notice Dispatch the message it to the destination domain & recipient
     * @dev Format the message, insert its hash into Merkle tree,
     * and emit `Dispatch` event with message information.
     * @param _destinationDomain Domain of destination chain
     * @param _recipientAddress Address of recipient on destination chain as bytes32
     * @param _messageBody Raw bytes content of message
     * @return The leaf index of the dispatched message's hash in the Merkle tree.
     */
    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external override returns (uint256) {
        require(_messageBody.length <= MAX_MESSAGE_BODY_BYTES, "msg too long");
        // The leaf has not been inserted yet at this point
        uint256 _leafIndex = count();
        // format the message into packed bytes
        bytes memory _message = Message.formatMessage(
            localDomain,
            msg.sender.addressToBytes32(),
            _destinationDomain,
            _recipientAddress,
            _messageBody
        );
        // insert the hashed message into the Merkle tree
        bytes32 _messageHash = keccak256(
            abi.encodePacked(
                _message,
                _leafIndex,
                address(this).addressToBytes32(),
                VERSION
            )
        );
        tree.insert(_messageHash);
        emit Dispatch(_leafIndex, _message);
        return _leafIndex;
    }

    /**
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
        bytes32 _originMailbox,
        bytes32 _root,
        uint256 _index,
        bytes calldata _sovereignData,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external override nonReentrant {
        require(_index >= _leafIndex, "!index");
        bytes32 _messageHash = _message.hash(
            _leafIndex,
            _originMailbox,
            VERSION
        );
        // ensure that message has not been processed
        require(
            messages[_messageHash] == MessageStatus.None,
            "!MessageStatus.None"
        );
        {
            // calculate the expected root based on the proof
            bytes32 _calculatedRoot = MerkleLib.branchRoot(
                _messageHash,
                _proof,
                _leafIndex
            );
            // verify the merkle proof
            require(_calculatedRoot == _root, "!proof");
        }

        {
            ISovereignRecipient _recipient = ISovereignRecipient(
                _message.recipientAddress()
            );
            // For backwards compatibility, use a default zone if not specified by the recipient.
            ISovereignZone _zone;
            try _recipient.zone() returns (ISovereignZone _val) {
                _zone = _val;
            } catch {
                _zone = defaultZone;
            }

            require(
                _zone.accept(_root, _index, _sovereignData, _message),
                "!zone"
            );
        }

        {
            uint32 _origin = _process(_message, _messageHash);
            emit Process(_messageHash, _root, _proof, _origin, _originMailbox);
        }
    }

    // ============ Internal Functions ============

    /**
     * @notice Marks a message as processed and calls handle on the recipient
     * @dev Internal function that can be called by contracts like TestInbox
     * @param _message Formatted message (refer to Mailbox.sol Message library)
     * @param _messageHash keccak256 hash of the message
     */
    function _process(bytes calldata _message, bytes32 _messageHash)
        internal
        returns (uint32)
    {
        // ensure message was meant for this domain
        require(_message.destination() == localDomain, "!destination");

        // update message status as processed
        messages[_messageHash] = MessageStatus.Processed;

        uint32 _origin = _message.origin();
        IMessageRecipient(_message.recipientAddress()).handle(
            _origin,
            _message.sender(),
            _message.body()
        );
        return _origin;
    }

    /**
     * @notice Calculates and returns tree's current root
     */
    function root() public view returns (bytes32) {
        return tree.root();
    }

    /**
     * @notice Returns the number of inserted leaves in the tree
     */
    function count() public view returns (uint256) {
        return tree.count;
    }

    /**
     * @notice Returns a checkpoint representing the current merkle tree.
     * @return root The root of the Outbox's merkle tree.
     * @return index The index of the last element in the tree.
     */
    function latestCheckpoint() public view returns (bytes32, uint256) {
        return (root(), count() - 1);
    }
}
