// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Versioned} from "./upgrade/Versioned.sol";
import {MerkleLib} from "./libs/Merkle.sol";
import {Message} from "./libs/Message.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";
import {IMessageRecipient, IHasInterchainSecurityModule} from "../interfaces/IMessageRecipient.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
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
    uint32 public immutable version;

    // ============ Public Storage ============
    IInterchainSecurityModule public defaultModule;
    MerkleLib.Tree public tree;
    // Mapping of message ID to whether or not that message has been delivered.
    mapping(bytes32 => bool) public delivered;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a new message is dispatched via Abacus
     * @param message Raw bytes of message
     */
    event Dispatch(bytes32 indexed messageId, bytes message);
    event Process(bytes32 indexed messageId);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(uint32 _localDomain, uint32 _version) {
        localDomain = _localDomain;
        version = _version;
    }

    // ============ Initializer ============

    function initialize(address _defaultModule) external initializer {
        __ReentrancyGuard_init();
        // TODO: setDefaultModule, check for isContract.
        defaultModule = IInterchainSecurityModule(_defaultModule);
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
    ) external override returns (bytes32) {
        require(_messageBody.length <= MAX_MESSAGE_BODY_BYTES, "msg too long");
        // Format the message into packed bytes.
        bytes memory _message = Message.formatMessage(
            version,
            count(),
            localDomain,
            msg.sender.addressToBytes32(),
            _destinationDomain,
            _recipientAddress,
            _messageBody
        );

        // Insert the message ID into the merkle tree.
        bytes32 _id = _message.id();
        tree.insert(_id);
        emit Dispatch(_id, _message);
        return _id;
    }

    /**
     * @notice Attempts to process the provided formatted `message`. Performs
     * verification against root of the proof
     * @dev Called by the validator manager, which is responsible for verifying a
     * quorum of validator signatures on the checkpoint.
     * @dev Reverts if verification of the message fails.
     * @param _message Formatted message (refer to Mailbox.sol Message library)
     */
    function process(bytes calldata _message, bytes calldata _metadata)
        external
        override
        nonReentrant
    {
        // TODO: If we wanted to support multiple message types,
        // you could have a library for each type that tells the mailbox
        // what to do with the message.

        // Check that the message was intended for this mailbox.
        require(_message.version() == version, "!version");
        require(_message.destination() == localDomain, "!destination");

        // Check that the message hasn't already been delivered.
        bytes32 _id = _message.id();
        require(delivered[_id] == false, "delivered");
        delivered[_id] = true;

        // Verify the message in the ISM.
        IInterchainSecurityModule _ism = _recipientModule(
            IHasInterchainSecurityModule(_message.recipientAddress())
        );
        require(_ism.verify(_message, _metadata));

        // Deliver the message to the recipient.
        uint32 _origin = _message.origin();
        IMessageRecipient(_message.recipientAddress()).handle(
            _origin,
            _message.sender(),
            _message.body()
        );
        emit Process(_id);
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

    function _recipientModule(IHasInterchainSecurityModule _recipient)
        internal
        view
        returns (IInterchainSecurityModule)
    {
        // For backwards compatibility, use a default
        // interchainSecurityModule if one is not specified by the
        // recipient.
        try _recipient.interchainSecurityModule() returns (
            IInterchainSecurityModule _val
        ) {
            return _val;
        } catch {
            return defaultModule;
        }
    }
}
