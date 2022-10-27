// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Versioned} from "./upgrade/Versioned.sol";
import {MerkleLib} from "./libs/Merkle.sol";
import {Message} from "./libs/Message.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IInterchainSecurityModule, IUsesInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

contract Mailbox is
    IMailbox,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    Versioned
{
    // ============ Libraries ============

    using MerkleLib for MerkleLib.Tree;
    using Message for bytes;
    using TypeCasts for bytes32;
    using TypeCasts for address;

    // ============ Constants ============

    // Maximum bytes per message = 2 KiB (somewhat arbitrarily set to begin)
    uint256 public constant MAX_MESSAGE_BODY_BYTES = 2 * 2**10;
    // Domain of chain on which the contract is deployed
    uint32 public immutable localDomain;

    // ============ Public Storage ============

    // The default ISM, used if the recipient fails to specify one.
    IInterchainSecurityModule public defaultModule;
    // An incremental merkle tree used to store outbound message IDs.
    MerkleLib.Tree public tree;
    // Mapping of message ID to whether or not that message has been delivered.
    mapping(bytes32 => bool) public delivered;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when the default ISM is updated
     * @param module The new default ISM
     */
    event DefaultModuleSet(address indexed module);

    /**
     * @notice Emitted when a new message is dispatched via Hyperlane
     * @param messageId The unique message identifier
     * @param message Raw bytes of message
     */
    event Dispatch(bytes32 indexed messageId, bytes message);

    /**
     * @notice Emitted when a Hyperlane message is delivered
     * @param messageId The unique message identifier
     */
    event Process(bytes32 indexed messageId);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    // ============ Initializer ============

    function initialize(address _defaultModule) external initializer {
        __ReentrancyGuard_init();
        __Ownable_init();
        _setDefaultModule(_defaultModule);
    }

    // ============ External Functions ============

    /**
     * @notice Sets the default ISM for the Mailbox.
     * @param _module The new default ISM. Must be a contract.
     */
    function setDefaultModule(address _module) external onlyOwner {
        _setDefaultModule(_module);
    }

    /**
     * @notice Dispatches a message to the destination domain & recipient.
     * @param _destinationDomain Domain of destination chain
     * @param _recipientAddress Address of recipient on destination chain as bytes32
     * @param _messageBody Raw bytes content of message body
     * @return The message ID inserted into the Mailbox's merkle tree
     */
    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external override returns (bytes32) {
        require(_messageBody.length <= MAX_MESSAGE_BODY_BYTES, "msg too long");
        // Format the message into packed bytes.
        bytes memory _message = Message.formatMessage(
            VERSION,
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
     * @notice Attempts to deliver `_message` to its recipient. Verifies
     * `_message` via the recipient's ISM using the provided `_metadata`.
     * @param _metadata Metadata used by the ISM to verify `_message`.
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function process(bytes calldata _metadata, bytes calldata _message)
        external
        override
        nonReentrant
    {
        // Check that the message was intended for this mailbox.
        require(_message.version() == VERSION, "!version");
        require(_message.destination() == localDomain, "!destination");

        // Check that the message hasn't already been delivered.
        bytes32 _id = _message.id();
        require(delivered[_id] == false, "delivered");
        delivered[_id] = true;

        // Verify the message via the ISM.
        IInterchainSecurityModule _ism = _recipientModule(
            IUsesInterchainSecurityModule(_message.recipientAddress())
        );
        require(_ism.verify(_metadata, _message), "!module");

        // Deliver the message to the recipient.
        uint32 _origin = _message.origin();
        IMessageRecipient(_message.recipientAddress()).handle(
            _origin,
            _message.sender(),
            _message.body()
        );
        emit Process(_id);
    }

    // ============ Public Functions ============

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

    // ============ Internal Functions ============

    /**
     * @notice Sets the default ISM for the Mailbox.
     * @param _module The new default ISM. Must be a contract.
     */
    function _setDefaultModule(address _module) internal {
        require(Address.isContract(_module), "!contract");
        defaultModule = IInterchainSecurityModule(_module);
        emit DefaultModuleSet(_module);
    }

    /**
     * @notice Returns the ISM to use for the recipient, defaulting to the
     * default ISM if none is specified.
     * @param _recipient The message recipient whose ISM should be returned.
     * @return The ISM to use for `_recipient`.
     */
    function _recipientModule(IUsesInterchainSecurityModule _recipient)
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
