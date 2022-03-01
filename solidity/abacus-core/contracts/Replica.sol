// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {Version0} from "./Version0.sol";
import {Common} from "./Common.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {IMessageRecipient, ISovereignRecipient } from "../interfaces/IMessageRecipient.sol";
import {CheckpointVerifier} from "./Checkpoint.sol";
// ============ External Imports ============
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";

/**
 * @title Replica
 * @author Celo Labs Inc.
 * @notice Track root updates on Home,
 * prove and dispatch messages to end recipients.
 */
contract Replica is Version0, Common, CheckpointVerifier {
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

    // ============ Immutables ============

    // Minimum gas for message processing
    uint256 public immutable PROCESS_GAS;
    // Reserved gas (to ensure tx completes in case message processing runs out)
    uint256 public immutable RESERVE_GAS;

    // ============ Public Storage ============

    // Domain of home chain
    uint32 public remoteDomain;
    // re-entrancy guard
    uint8 private entered;
    // Mapping of message leaves to MessageStatus
    mapping(bytes32 => bytes32) public messages;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when message is processed
     * @param messageHash Hash of message that failed to process
     * @param success TRUE if the call was executed successfully, FALSE if the call reverted
     * @param returnData the return data from the external call
     */
    event Process(
        bytes32 indexed messageHash,
        bool indexed success,
        bytes indexed returnData
    );

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _localDomain,
        uint256 _processGas,
        uint256 _reserveGas
    ) Common(_localDomain) {
        require(_processGas >= 850_000, "!process gas");
        require(_reserveGas >= 15_000, "!reserve gas");
        PROCESS_GAS = _processGas;
        RESERVE_GAS = _reserveGas;
    }

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
        bytes memory _signature
    ) external {
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
     * @param _index Index of leaf in home's merkle tree
     */
    function proveAndProcess(
        bytes memory _message,
        bytes32[32] calldata _proof,
        uint256 _index
    ) external {
        require(prove(keccak256(_message), _proof, _index), "!prove");
        process(_message);
    }

    // ============ Public Functions ============
    function process(bytes memory _message) public returns (bool) {
        // check re-entrancy guard
        require(entered == 1, "!reentrant");
        entered = 0;
        bytes29 _m = _message.ref(0);
        bytes32 _messageHash = _m.keccak();
        uint32 _origin = _m.origin();
        address _recipient = _m.recipientAddress();

        require(ISovereignRecipient(_recipient).sovereign() == address(0), "!sovereign");
        return _process(_m, _messageHash, _origin, _recipient);
    }

    function sovereignProcess(bytes memory _message, bytes memory _signature) public returns (bool) {
        // check re-entrancy guard
        require(entered == 1, "!reentrant");
        entered = 0;
        bytes29 _m = _message.ref(0);
        bytes32 _messageHash = _m.keccak();
        uint32 _origin = _m.origin();
        address _recipient = _m.recipientAddress();

        // Sovereign consensus.
        address _sovereign = ISovereignRecipient(_recipient).sovereign();
        bytes32 _root = messages[_messageHash];
        uint256 _index = checkpoints[_root];
        address _signer = checkpointSigner(_origin, _root, _index, _signature);
        require(_sovereign == _signer, "!sovereign");
        return _process(_m, _messageHash, _origin, _recipient);
    }

    function _process(bytes29 _m, bytes32 _messageHash, uint32 _origin, address _recipient) internal returns (bool _success) {
        // ensure message was meant for this domain
        require(_m.destination() == localDomain, "!destination");
        // ensure message has been proven
        require(messageStatus(_messageHash) == MessageStatus.Proven, "!proven");
        // update message status as processed
        messages[_messageHash] = bytes32(uint256(MessageStatus.Processed));
        // check re-entrancy guard
        require(entered == 1, "!reentrant");
        entered = 0;
        // A call running out of gas TYPICALLY errors the whole tx. We want to
        // a) ensure the call has a sufficient amount of gas to make a
        //    meaningful state change.
        // b) ensure that if the subcall runs out of gas, that the tx as a whole
        //    does not revert (i.e. we still mark the message processed)
        // To do this, we require that we have enough gas to process
        // and still return. We then delegate only the minimum processing gas.
        require(gasleft() >= PROCESS_GAS + RESERVE_GAS, "!gas");
        // set up for assembly call
        uint256 _toCopy;
        uint256 _maxCopy = 256;
        uint256 _gas = PROCESS_GAS;

        // allocate memory for returndata
        bytes memory _returnData = new bytes(_maxCopy);
        bytes memory _calldata = abi.encodeWithSignature(
            "handle(uint32,bytes32,bytes)",
            _origin,
            _m.sender(),
            _m.body().clone()
        );
        // dispatch message to recipient
        // by assembly calling "handle" function
        // we call via assembly to avoid memcopying a very large returndata
        // returned by a malicious contract
        assembly {
            _success := call(
                _gas, // gas
                _recipient, // recipient
                0, // ether value
                add(_calldata, 0x20), // inloc
                mload(_calldata), // inlen
                0, // outloc
                0 // outlen
            )
            // limit our copy to 256 bytes
            _toCopy := returndatasize()
            if gt(_toCopy, _maxCopy) {
                _toCopy := _maxCopy
            }
            // Store the length of the copied bytes
            mstore(_returnData, _toCopy)
            // copy the bytes from returndata[0:_toCopy]
            returndatacopy(add(_returnData, 0x20), 0, _toCopy)
        }
        // emit process results
        emit Process(_messageHash, _success, _returnData);
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
     * @param _index Index of leaf in home's merkle tree
     * @return Returns true if proof was valid and `prove` call succeeded
     **/
    function prove(
        bytes32 _leaf,
        bytes32[32] calldata _proof,
        uint256 _index
    ) public returns (bool) {
        // ensure that message has not been processed
        require(messages[_leaf] != bytes32(uint256(MessageStatus.Processed)), "processed");
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(_leaf, _proof, _index);
        // if the root is valid, change status to Proven
        if (checkpoints[_calculatedRoot] > 0) {
            messages[_leaf] = _calculatedRoot;
            return true;
        }
        return false;
    }

    function messageStatus(bytes32 _leaf) public view returns(MessageStatus) {
      bytes32 status = messages[_leaf];
      if (status == bytes32(uint256(MessageStatus.None))) {
        return MessageStatus.None;
      }
      if (status == bytes32(uint256(MessageStatus.Processed))) {
        return MessageStatus.Processed;
      }
      return MessageStatus.Proven;
    }
}
