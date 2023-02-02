// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {IMultisigIsm} from "../../interfaces/IMultisigIsm.sol";
import {Message} from "../libs/Message.sol";
import {MultisigIsmMetadata} from "../libs/MultisigIsmMetadata.sol";
import {EnumerableThresholdedSet} from "../libs/EnumerableThresholdedSet.sol";
import {OwnableThresholdedSet} from "../libs/OwnableThresholdedSet.sol";
import {MerkleLib} from "../libs/Merkle.sol";

/**
 * @title MultisigIsm
 * @notice Manages an ownable set of validators that ECDSA sign checkpoints to
 * reach a quorum.
 */
contract MultisigIsm is IMultisigIsm, OwnableThresholdedSet {
    // ============ Libraries ============

    using EnumerableThresholdedSet for EnumerableThresholdedSet.AddressSet;
    using Message for bytes;
    using MultisigIsmMetadata for bytes;
    using MerkleLib for MerkleLib.Tree;

    // ============ Constants ============

    uint8 public constant moduleType = 3;

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() OwnableThresholdedSet() {}

    // ============ Public Functions ============

    /**
     * @notice Verifies that a quorum of the origin domain's validators signed
     * a checkpoint, and verifies the merkle proof of `_message` against that
     * checkpoint.
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        view
        returns (bool)
    {
        require(_verifyMerkleProof(_metadata, _message), "!merkle");
        require(_verifyValidatorSignatures(_metadata, _message), "!sigs");
        return true;
    }

    /**
     * @notice Returns the set of validators responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return validators The array of validator addresses
     * @return threshold The number of validator signatures needed
     */
    function validatorsAndThreshold(bytes calldata _message)
        external
        view
        returns (address[] memory, uint8)
    {
        uint32 _origin = _message.origin();
        address[] memory _validators = elements(_origin);
        uint8 _threshold = threshold(_origin);
        return (_validators, _threshold);
    }

    // ============ Internal Functions ============

    /**
     * @notice Verifies the merkle proof of `_message` against the provided
     * checkpoint.
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function _verifyMerkleProof(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal pure returns (bool) {
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(
            _message.id(),
            _metadata.proof(),
            _message.nonce()
        );
        return _calculatedRoot == _metadata.root();
    }

    /**
     * @notice Verifies that a quorum of the origin domain's validators signed
     * the provided checkpoint.
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function _verifyValidatorSignatures(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view returns (bool) {
        uint8 _threshold = _metadata.threshold();
        uint32 _origin = _message.origin();
        // Ensures the validator set encoded in the metadata matches
        // what we've stored on chain.
        // NB: An empty validator set in `_metadata` will result in a
        // non-zero computed commitment, and this check will fail
        // as the commitment in storage will be zero.
        require(
            setMatches(_origin, _threshold, _metadata.validators()),
            "!matches"
        );
        bytes32 _digest = _getCheckpointDigest(_metadata, _origin);
        uint256 _validatorCount = _metadata.validatorCount();
        uint256 _validatorIndex = 0;
        // Assumes that signatures are ordered by validator
        for (uint256 i = 0; i < _threshold; ++i) {
            address _signer = ECDSA.recover(_digest, _metadata.signatureAt(i));
            // Loop through remaining validators until we find a match
            for (
                ;
                _validatorIndex < _validatorCount &&
                    _signer != _metadata.validatorAt(_validatorIndex);
                ++_validatorIndex
            ) {}
            // Fail if we never found a match
            require(_validatorIndex < _validatorCount, "!threshold");
            ++_validatorIndex;
        }
        return true;
    }

    /**
     * @notice Returns the domain hash that validators are expected to use
     * when signing checkpoints.
     * @param _origin The origin domain of the checkpoint.
     * @param _originMailbox The address of the origin mailbox as bytes32.
     * @return The domain hash.
     */
    function _getDomainHash(uint32 _origin, bytes32 _originMailbox)
        internal
        pure
        returns (bytes32)
    {
        // Including the origin mailbox address in the signature allows the slashing
        // protocol to enroll multiple mailboxes. Otherwise, a valid signature for
        // mailbox A would be indistinguishable from a fraudulent signature for mailbox
        // B.
        // The slashing protocol should slash if validators sign attestations for
        // anything other than a whitelisted mailbox.
        return
            keccak256(abi.encodePacked(_origin, _originMailbox, "HYPERLANE"));
    }

    /**
     * @notice Returns the digest validators are expected to sign when signing checkpoints.
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
     * @return The digest of the checkpoint.
     */
    function _getCheckpointDigest(bytes calldata _metadata, uint32 _origin)
        internal
        pure
        returns (bytes32)
    {
        bytes32 _domainHash = _getDomainHash(
            _origin,
            _metadata.originMailbox()
        );
        return
            ECDSA.toEthSignedMessageHash(
                keccak256(
                    abi.encodePacked(
                        _domainHash,
                        _metadata.root(),
                        _metadata.index()
                    )
                )
            );
    }
}
