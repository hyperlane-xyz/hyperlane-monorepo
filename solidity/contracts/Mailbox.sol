// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Versioned} from "./upgrade/Versioned.sol";
import {MerkleLib} from "./libs/Merkle.sol";
import {Message} from "./libs/Message.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";
import {IMessageRecipient} from "./interfaces/IMessageRecipient.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "./interfaces/IInterchainSecurityModule.sol";
import {IMailbox} from "./interfaces/IMailbox.sol";
import {PausableReentrancyGuardUpgradeable} from "./PausableReentrancyGuard.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract Mailbox is
    IMailbox,
    OwnableUpgradeable,
    PausableReentrancyGuardUpgradeable,
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
    IInterchainSecurityModule public defaultIsm;
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
    event DefaultIsmSet(address indexed module);

    /**
     * @notice Emitted when Mailbox is paused
     */
    event Paused();

    /**
     * @notice Emitted when Mailbox is unpaused
     */
    event Unpaused();

    // ============ Constructor ============

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    // ============ Initializers ============

    function initialize(address _owner, address _defaultIsm)
        external
        initializer
    {
        __PausableReentrancyGuard_init();
        __Ownable_init();
        transferOwnership(_owner);
        _setDefaultIsm(_defaultIsm);
    }

    // ============ External Functions ============

    /**
     * @notice Sets the default ISM for the Mailbox.
     * @param _module The new default ISM. Must be a contract.
     */
    function setDefaultIsm(address _module) external onlyOwner {
        _setDefaultIsm(_module);
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
    ) external override notPaused returns (bytes32) {
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
        emit Dispatch(
            msg.sender,
            _destinationDomain,
            _recipientAddress,
            _message
        );
        emit DispatchId(_id);
        return _id;
    }

    /**
     * @notice Attempts to deliver `_message` to its recipient. Verifies
     * `_message` via the recipient's ISM using the provided `_metadata`.
     * @param _metadata Metadata used by the ISM to verify `_message`.
     * @param _message Formatted Hyperlane message (refer to Message.sol).
     */
    function process(bytes calldata _metadata, bytes calldata _message)
        external
        override
        nonReentrantAndNotPaused
    {
        // Check that the message was intended for this mailbox.
        require(_message.version() == VERSION, "!version");
        require(_message.destination() == localDomain, "!destination");

        // Check that the message hasn't already been delivered.
        bytes32 _id = _message.id();
        require(delivered[_id] == false, "delivered");
        delivered[_id] = true;

        // Verify the message via the ISM.
        IInterchainSecurityModule _ism = IInterchainSecurityModule(
            recipientIsm(_message.recipientAddress())
        );
        require(_ism.verify(_metadata, _message), "!module");

        // Deliver the message to the recipient.
        uint32 origin = _message.origin();
        bytes32 sender = _message.sender();
        address recipient = _message.recipientAddress();
        IMessageRecipient(recipient).handle(origin, sender, _message.body());
        emit Process(origin, sender, recipient);
        emit ProcessId(_id);
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
    function count() public view returns (uint32) {
        // count cannot exceed 2**TREE_DEPTH, see MerkleLib.sol
        return uint32(tree.count);
    }

    /**
     * @notice Returns a checkpoint representing the current merkle tree.
     * @return root The root of the Mailbox's merkle tree.
     * @return index The index of the last element in the tree.
     */
    function latestCheckpoint() external view returns (bytes32, uint32) {
        return (root(), count() - 1);
    }

    /**
     * @notice Pauses mailbox and prevents further dispatch/process calls
     * @dev Only `owner` can pause the mailbox.
     */
    function pause() external onlyOwner {
        _pause();
        emit Paused();
    }

    /**
     * @notice Unpauses mailbox and allows for message processing.
     * @dev Only `owner` can unpause the mailbox.
     */
    function unpause() external onlyOwner {
        _unpause();
        emit Unpaused();
    }

    /**
     * @notice Returns whether mailbox is paused.
     */
    function isPaused() external view returns (bool) {
        return _isPaused();
    }

    /**
     * @notice Returns the ISM to use for the recipient, defaulting to the
     * default ISM if none is specified.
     * @param _recipient The message recipient whose ISM should be returned.
     * @return The ISM to use for `_recipient`.
     */
    function recipientIsm(address _recipient)
        public
        view
        returns (IInterchainSecurityModule)
    {
        // Use a default interchainSecurityModule if one is not specified by the
        // recipient.
        // This is useful for backwards compatibility and for convenience as
        // recipients are not mandated to specify an ISM.
        try
            ISpecifiesInterchainSecurityModule(_recipient)
                .interchainSecurityModule()
        returns (IInterchainSecurityModule _val) {
            // If the recipient specifies a zero address, use the default ISM.
            if (address(_val) != address(0)) {
                return _val;
            }
            // solhint-disable-next-line no-empty-blocks
        } catch {}
        return defaultIsm;
    }

    // ============ Internal Functions ============

    /**
     * @notice Sets the default ISM for the Mailbox.
     * @param _module The new default ISM. Must be a contract.
     */
    function _setDefaultIsm(address _module) internal {
        require(Address.isContract(_module), "!contract");
        defaultIsm = IInterchainSecurityModule(_module);
        emit DefaultIsmSet(_module);
    }
}
