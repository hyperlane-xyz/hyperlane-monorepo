// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";
import {StaticMultisigIsmMetadata} from "../libs/StaticMultisigIsmMetadata.sol";
import {MerkleLib} from "../libs/Merkle.sol";

interface IMultisigIsmVerifier {
    function verify(
        uint32 _origin,
        uint32 _nonce,
        bytes32 _id,
        address[] calldata _validators,
        uint8 _threshold,
        bytes calldata _metadata
    ) external pure returns (bool);
}

contract MultisigIsmVerifier is IMultisigIsmVerifier {
    // ============ Libraries ============

    using Message for bytes;
    using StaticMultisigIsmMetadata for bytes;
    using MerkleLib for MerkleLib.Tree;

    // ============ Public Functions ============

    function verify(
        uint32 _origin,
        uint32 _nonce,
        bytes32 _id,
        address[] calldata _validators,
        uint8 _threshold,
        bytes calldata _metadata
    ) external pure returns (bool) {
        require(_verifyMerkleProof(_nonce, _id, _metadata), "!merkle");
        require(
            _verifyValidatorSignatures(
                _origin,
                _validators,
                _threshold,
                _metadata
            ),
            "!sigs"
        );
        return true;
    }

    // ============ Internal Functions ============

    function _verifyMerkleProof(
        uint32 _nonce,
        bytes32 _id,
        bytes calldata _metadata
    ) internal pure returns (bool) {
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(
            _id,
            _metadata.proof(),
            _nonce
        );
        return _calculatedRoot == _metadata.root();
    }

    function _verifyValidatorSignatures(
        uint32 _origin,
        address[] calldata _validators,
        uint8 _threshold,
        bytes calldata _metadata
    ) internal pure returns (bool) {
        bytes32 _digest = _getCheckpointDigest(_metadata, _origin);
        uint256 _validatorCount = _validators.length;
        uint256 _validatorIndex = 0;
        // Assumes that signatures are ordered by validator
        for (uint256 i = 0; i < _threshold; ++i) {
            address _signer = ECDSA.recover(_digest, _metadata.signatureAt(i));
            // Loop through remaining validators until we find a match
            for (
                ;
                _validatorIndex < _validatorCount &&
                    _signer != _validators[_validatorIndex];
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
     * @param _origin The origin domain of the checkpoint.
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
