// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Version0} from "./Version0.sol";
import {Common} from "./Common.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {MerkleTreeManager} from "./MerkleTreeManager.sol";
import {IOutbox} from "../interfaces/IOutbox.sol";

/**
 * @title Outbox
 * @author Celo Labs Inc.
 * @notice Accepts messages to be dispatched to remote chains,
 * constructs a Merkle tree of the messages,
 * and accepts signatures from a bonded Validator
 * which notarize the Merkle tree roots.
 * Accepts submissions of fraudulent signatures
 * by the Validator and slashes the Validator in this case.
 */
contract Outbox is IOutbox, Version0, MerkleTreeManager, Common {
    // ============ Libraries ============

    using MerkleLib for MerkleLib.Tree;
    using TypeCasts for address;

    // ============ Constants ============

    // Maximum bytes per message = 2 KiB
    // (somewhat arbitrarily set to begin)
    uint256 public constant MAX_MESSAGE_BODY_BYTES = 2 * 2**10;

    // ============ Enums ============

    // States:
    //   0 - UnInitialized - before initialize function is called
    //   note: the contract is initialized at deploy time, so it should never be in this state
    //   1 - Active - as long as the contract has not become fraudulent
    //   2 - Failed - after a valid fraud proof has been submitted;
    //   contract will no longer accept updates or new messages
    enum States {
        UnInitialized,
        Active,
        Failed
    }

    // ============ Public Storage Variables ============

    // Current state of contract
    States public state;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[49] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a new message is dispatched via Abacus
     * @param messageHash Hash of message; the leaf inserted to the Merkle tree for the message
     * @param leafIndex Index of message's leaf in merkle tree
     * @param destination Destination domain
     * @param message Raw bytes of message
     */
    event Dispatch(
        bytes32 indexed messageHash,
        uint256 indexed leafIndex,
        uint32 indexed destination,
        bytes message
    );

    event Fail();

    // ============ Constructor ============

    constructor(uint32 _localDomain) Common(_localDomain) {} // solhint-disable-line no-empty-blocks

    // ============ Initializer ============

    function initialize(address _validatorManager) public initializer {
        __Common_initialize(_validatorManager);
        state = States.Active;
    }

    // ============ Modifiers ============

    /**
     * @notice Ensures that contract state != FAILED when the function is called
     */
    modifier notFailed() {
        require(state != States.Failed, "failed state");
        _;
    }

    // ============ External Functions  ============

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
    ) external override notFailed returns (uint256) {
        require(_messageBody.length <= MAX_MESSAGE_BODY_BYTES, "msg too long");
        // The leaf has not been inserted yet at this point1
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
            abi.encodePacked(_message, _leafIndex)
        );
        tree.insert(_messageHash);
        // Emit Dispatch event with message information
        emit Dispatch(_messageHash, _leafIndex, _destinationDomain, _message);
        return _leafIndex;
    }

    /**
     * @notice Caches the current merkle root and index.
     * @dev emits Checkpoint event
     */
    function cacheCheckpoint() external override notFailed {
        (bytes32 root, uint256 index) = latestCheckpoint();
        _cacheCheckpoint(root, index);
    }

    /**
     * @notice Set contract state to FAILED.
     * @dev Called by the validator manager when fraud is proven.
     */
    function fail() external override onlyValidatorManager {
        // set contract to FAILED
        state = States.Failed;
        emit Fail();
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
