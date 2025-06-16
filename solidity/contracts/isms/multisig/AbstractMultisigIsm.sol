// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {IMultisigIsm} from "../../interfaces/isms/IMultisigIsm.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/**
 * @title AbstractMultisig
 * @notice Manages per-domain m-of-n Validator sets
 * @dev See ./AbstractMerkleRootMultisigIsm.sol and ./AbstractMessageIdMultisigIsm.sol
 * for concrete implementations of `digest` and `signatureAt`.
 * @dev See ./StaticMultisigIsm.sol for concrete implementations.
 */
abstract contract AbstractMultisig is PackageVersioned {
    /**
     * @notice Returns the digest to be used for signature verification.
     * @param _metadata ABI encoded module metadata
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return digest The digest to be signed by validators
     */
    function digest(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view virtual returns (bytes32);

    /**
     * @notice Returns the signature at a given index from the metadata.
     * @param _metadata ABI encoded module metadata
     * @param _index The index of the signature to return
     * @return signature Packed encoding of signature (65 bytes)
     */
    function signatureAt(
        bytes calldata _metadata,
        uint256 _index
    ) internal pure virtual returns (bytes calldata);

    /**
     * @notice Returns the number of signatures in the metadata.
     * @param _metadata ABI encoded module metadata
     * @return count The number of signatures
     */
    function signatureCount(
        bytes calldata _metadata
    ) public pure virtual returns (uint256);
}

/**
 * @title AbstractMultisigIsm
 * @notice Manages per-domain m-of-n Validator sets of AbstractMultisig that are used to verify
 * interchain messages.
 */
abstract contract AbstractMultisigIsm is AbstractMultisig, IMultisigIsm {
    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    /**
     * @notice Returns the set of validators responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @dev Signatures provided to `verify` must be consistent with validator ordering
     * @param _message Hyperlane formatted interchain message
     * @return validators The array of validator addresses
     * @return threshold The number of validator signatures needed
     */
    function validatorsAndThreshold(
        bytes calldata _message
    ) public view virtual returns (address[] memory, uint8);

    // ============ Public Functions ============

    /**
     * @notice Requires that m-of-n validators verify a merkle root,
     * and verifies a merkle proof of `_message` against that root.
     * @dev Optimization relies on the caller sorting signatures in the same order as validators.
     * @dev Employs https://www.geeksforgeeks.org/two-pointers-technique/ to minimize gas usage.
     * @param _metadata ABI encoded module metadata
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) public view returns (bool) {
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
