// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Version0} from "./Version0.sol";
import {Common} from "./Common.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
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
contract Outbox is IOutbox, Version0, Common {
    // ============ Libraries ============

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

    // What do we actually want to store here? What are validators signing?
    // If keep a cumulative hash, and I have H_a = H(a), H_b = H(b, H_a), H_c = H(c, H_b)
    // If I have a signature on H_c, how do I use that to process b?
    // I provide H_a, [b], and signature
    // i.e. start, messages, signature, message index
    // _process(bytes32 start, bytes32[] digests, bytes signature, bytes message)
    // process(bytes32 start, bytes message, bytes signature)
    // Can we use an RSA accumulator instead?

    bytes32 public commitment;
    mapping(bytes32 => bool) commitments;

    // gap for upgrade safety
    uint256[48] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a new message is dispatched via Abacus
     * @param destination Destination domain
     * @param message Raw bytes of message
     */
    event Dispatch(
        bytes32 indexed messageHash,
        bytes32 indexed commitment,
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
    ) external override notFailed returns (bytes32) {
        require(_messageBody.length <= MAX_MESSAGE_BODY_BYTES, "msg too long");
        // format the message into packed bytes
        bytes memory _message = Message.formatMessage(
            localDomain,
            msg.sender.addressToBytes32(),
            _destinationDomain,
            _recipientAddress,
            _messageBody
        );

        bytes32 _messageHash = keccak256(_message);

        commitment = keccak256(abi.encodePacked(commitment, _messageHash));
        commitments[commitment] = true;

        // Emit Dispatch event with message information
        emit Dispatch(_messageHash, commitment, _destinationDomain, _message);
        return _messageHash;
    }

    function isCommitment(bytes32 _commitment)
        external
        view
        override
        returns (bool)
    {
        return commitments[_commitment];
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
