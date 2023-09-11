// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IMultisigIsm} from "../../interfaces/isms/IMultisigIsm.sol";
import {Message} from "../../libs/Message.sol";
import {MerkleLib} from "../../libs/Merkle.sol";

/**
 * @title MultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used to verify
 * interchain messages.
 * @dev See ./AbstractMerkleRootMultisigIsm.sol and ./AbstractMessageIdMultisigIsm.sol
 * for concrete implementations of `digest` and `signatureAt`.
 * @dev See ./StaticMultisigIsm.sol for concrete implementations.
 */
abstract contract AbstractMultisigIsm is IMultisigIsm {
    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    /**
     * @notice Returns the set of validators responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return validators The array of validator addresses
     * @return threshold The number of validator signatures needed
     */
    function validatorsAndThreshold(bytes calldata _message)
        public
        view
        virtual
        returns (address[] memory, uint8);

    /**
     * @notice Returns the digest to be used for signature verification.
     * @param _metadata ABI encoded module metadata
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return digest The digest to be signed by validators
     */
    function digest(bytes calldata _metadata, bytes calldata _message)
        internal
        view
        virtual
        returns (bytes32);

    /**
     * @notice Returns the signature at a given index from the metadata.
     * @param _metadata ABI encoded module metadata
     * @param _index The index of the signature to return
     * @return signature Packed encoding of signature (65 bytes)
     */
    function signatureAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        virtual
        returns (bytes memory);

    // ============ Public Functions ============

    /**
     * @notice Requires that m-of-n validators verify a merkle root,
     * and verifies a me∑rkle proof of `_message` against that root.
     * @param _metadata ABI encoded module metadata
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        view
        returns (bool)
    {
        bytes32 _digest = digest(_metadata, _message);
        (
            address[] memory _validators,
            uint8 _threshold
        ) = validatorsAndThreshold(_message);
        require(_threshold > 0, "No MultisigISM threshold present for message");

        uint256 _validatorCount = _validators.length;
        uint256 _validatorIndex = 0;
        // Assumes that signatures are ordered by validator
        for (uint256 i = 0; i < _threshold; ++i) {
            address _signer = ECDSA.recover(_digest, signatureAt(_metadata, i));
            // Loop through remaining validators until we find a match
            while (
                _validatorIndex < _validatorCount &&
                _signer != _validators[_validatorIndex]
            ) {
                ++_validatorIndex;
            }
            // Fail if we never found a match
            require(_validatorIndex < _validatorCount, "!threshold");
            ++_validatorIndex;
        }
        return true;
    }
}
