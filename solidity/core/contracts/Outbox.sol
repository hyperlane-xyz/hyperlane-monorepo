// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {Version0} from "./Version0.sol";
import {Common} from "./Common.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {MerkleTreeManager} from "./Merkle.sol";
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
    // domain => next available nonce for the domain
    mapping(uint32 => uint32) public nonces;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[48] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a new message is dispatched via Abacus
     * @param messageHash Hash of message; the leaf inserted to the Merkle tree for the message
     * @param leafIndex Index of message's leaf in merkle tree
     * @param destinationAndNonce Destination and destination-specific
     * nonce combined in single field ((destination << 32) & nonce)
     * @param checkpointedRoot the latest checkpointed root
     * @param message Raw bytes of message
     */
    event Dispatch(
        bytes32 indexed messageHash,
        uint256 indexed leafIndex,
        uint64 indexed destinationAndNonce,
        // Remove checkpointedRoot.
        bytes32 checkpointedRoot,
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

    /**
     * @notice Ensures that function is called by the ValidatorManager contract
     */
    modifier onlyValidatorManager() {
        require(msg.sender == address(validatorManager), "!validatorManager");
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
        bytes memory _messageBody
    ) external override notFailed returns (uint256) {
        require(_messageBody.length <= MAX_MESSAGE_BODY_BYTES, "msg too long");
        // get the next nonce for the destination domain, then increment it
        uint32 _nonce = nonces[_destinationDomain];
        nonces[_destinationDomain] = _nonce + 1;
        // format the message into packed bytes
        bytes memory _message = Message.formatMessage(
            localDomain,
            bytes32(uint256(uint160(msg.sender))),
            _nonce,
            _destinationDomain,
            _recipientAddress,
            _messageBody
        );
        // The leaf has not been inserted yet at this point
        uint256 _leafIndex = count();
        // insert the hashed message into the Merkle tree
        bytes32 _messageHash = keccak256(_message);
        tree.insert(_messageHash);
        // Emit Dispatch event with message information
        emit Dispatch(
            _messageHash,
            _leafIndex,
            _destinationAndNonce(_destinationDomain, _nonce),
            checkpointedRoot,
            _message
        );
        return _leafIndex;
    }

    /**
     * @notice Checkpoints the latest root and index.
     * Validators are expected to sign this checkpoint so that it can be
     * relayed to the Inbox contracts.
     * @dev emits Checkpoint event
     */
    function checkpoint() external override notFailed {
        uint256 count = count();
        require(count > 0, "!count");
        bytes32 root = root();
        _checkpoint(root, count);
    }

    /**
     * @notice Set contract state to FAILED.
     * @dev Called by the ValidatorManager when fraud is proven.
     */
    function fail() external onlyValidatorManager {
        // set contract to FAILED
        state = States.Failed;
        emit Fail();
    }

    // ============ Internal Functions  ============

    /**
     * @notice Internal utility function that combines
     * `_destination` and `_nonce`.
     * @dev Both destination and nonce should be less than 2^32 - 1
     * @param _destination Domain of destination chain
     * @param _nonce Current nonce for given destination chain
     * @return Returns (`_destination` << 32) & `_nonce`
     */
    function _destinationAndNonce(uint32 _destination, uint32 _nonce)
        internal
        pure
        returns (uint64)
    {
        return (uint64(_destination) << 32) | _nonce;
    }
}
