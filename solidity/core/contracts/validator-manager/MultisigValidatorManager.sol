// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title MultisigValidatorManager
 * @notice Manages an ownable set of validators that ECDSA sign checkpoints to
 * reach a quorum.
 */
abstract contract MultisigValidatorManager is Ownable {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;

    // ============ Immutables ============

    // The domain of the validator set's outbox chain.
    uint32 public immutable domain;

    // The domain hash of the validator set's outbox chain.
    bytes32 public immutable domainHash;

    // ============ Mutable Storage ============

    // The minimum threshold of validator signatures to constitute a quorum.
    uint256 public threshold;

    // The set of validators.
    EnumerableSet.AddressSet private validatorSet;
    bytes32 public validatorsCommitment;

    // ============ Events ============

    /**
     * @notice Emitted when a validator is enrolled in the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The new number of enrolled validators in the validator set.
     */
    event EnrollValidator(address indexed validator, uint256 validatorCount);

    /**
     * @notice Emitted when a validator is unenrolled from the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The new number of enrolled validators in the validator set.
     */
    event UnenrollValidator(address indexed validator, uint256 validatorCount);

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param threshold The new quorum threshold.
     */
    event SetThreshold(uint256 threshold);

    // ============ Constructor ============

    /**
     * @dev Reverts if `_validators` has any duplicates.
     * @param _domain The domain of the outbox the validator set is for.
     * @param _validators The set of validator addresses.
     * @param _threshold The quorum threshold. Must be greater than or equal
     * to the length of `_validators`.
     */
    constructor(
        uint32 _domain,
        address[] memory _validators,
        uint256 _threshold
    ) Ownable() {
        // Set immutables.
        domain = _domain;
        domainHash = _domainHash(_domain);

        // Enroll validators. Reverts if there are any duplicates.
        uint256 _numValidators = _validators.length;
        for (uint256 i = 0; i < _numValidators; i++) {
            _enrollValidator(_validators[i]);
        }

        _setThreshold(_threshold);
    }

    // ============ External Functions ============

    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function enrollValidator(address _validator) external onlyOwner {
        _enrollValidator(_validator);
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if `_validator` is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function unenrollValidator(address _validator) external onlyOwner {
        _unenrollValidator(_validator);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _threshold The new quorum threshold.
     */
    function setThreshold(uint256 _threshold) external onlyOwner {
        _setThreshold(_threshold);
    }

    /**
     * @notice Gets the addresses of the current validator set.
     * @dev There are no ordering guarantees due to the semantics of EnumerableSet.AddressSet.
     * @return The addresses of the validator set.
     */
    function validators() external view returns (address[] memory) {
        uint256 _numValidators = validatorSet.length();
        address[] memory _validators = new address[](_numValidators);
        for (uint256 i = 0; i < _numValidators; i++) {
            _validators[i] = validatorSet.at(i);
        }
        return _validators;
    }

    // ============ Public Functions ============

    /**
     * @notice Returns whether provided signatures over a checkpoint constitute
     * a quorum of validator signatures.
     * @dev Reverts if `_signatures` is not sorted in ascending order by the signer
     * address, which is required for duplicate detection.
     * @dev Does not revert if a signature's signer is not in the validator set.
     * @param _root The merkle root of the checkpoint.
     * @param _index The index of the checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @return TRUE iff `_signatures` constitute a quorum of validator signatures over
     * the checkpoint.
     */
    function isQuorum(
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures
    ) public view returns (bool) {
        uint256 _numSignatures = _signatures.length;
        // If there are fewer signatures provided than the required quorum threshold,
        // this is not a quorum.
        /*
        if (_numSignatures < threshold) {
            return false;
        }
        */
        bytes32 _digest = keccak256(
            abi.encodePacked(domainHash, _root, _index)
        );
        bytes32 _signedHash = ECDSA.toEthSignedMessageHash(_digest);
        // To identify duplicates, the signers recovered from _signatures
        // must be sorted in ascending order. previousSigner is used to
        // enforce ordering.
        address _previousSigner = address(0);
        uint256 _validatorSignatureCount = 0;
        for (uint256 i = 0; i < _numSignatures; i++) {
            address _signer = ECDSA.recover(_signedHash, _signatures[i]);
            // Revert if the signer violates the required sort order.
            require(_previousSigner < _signer, "!sorted signers");
            // If the signer is a validator, increment _validatorSignatureCount.
            if (isValidator(_signer)) {
                _validatorSignatureCount++;
            }
            _previousSigner = _signer;
        }
        return _validatorSignatureCount >= threshold;
    }

    function isQuorum2(
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures,
        address[] calldata _missing
    ) public view returns (bool) {
        uint256 _numSignatures = _signatures.length;
        // If there are fewer signatures provided than the required quorum threshold,
        // this is not a quorum.
        /*
        if (_numSignatures < threshold) {
            return false;
        }
        */
        require(_numSignatures == threshold, "!threshold");
        bytes32 _digest = keccak256(
            abi.encodePacked(domainHash, _root, _index)
        );
        bytes32 _signedHash = ECDSA.toEthSignedMessageHash(_digest);
        bytes32 _validators;
        // To identify duplicates, the signers recovered from _signatures
        // must be sorted in ascending order. previousSigner is used to
        // enforce ordering.
        uint256 missingIndex = 0;
        uint256 signaturesIndex = 0;
        uint256 length = validatorSet.length();
        address signer = ECDSA.recover(_signedHash, _signatures[0]);
        address missing = _missing[missingIndex];
        while (missingIndex + signaturesIndex < length) {
            if (missing < signer || signaturesIndex == _signatures.length) {
                _validators = keccak256(abi.encodePacked(_validators, missing));
                missingIndex += 1;
                if (missingIndex < _missing.length) {
                    missing = _missing[missingIndex];
                }
            } else {
                _validators = keccak256(abi.encodePacked(_validators, signer));
                signaturesIndex += 1;
                if (signaturesIndex < _signatures.length) {
                    signer = ECDSA.recover(
                        _signedHash,
                        _signatures[signaturesIndex]
                    );
                }
            }
        }
        require(_validators == validatorsCommitment, "!validators");
        return true;
    }

    /**
     * @notice Returns if `_validator` is enrolled in the validator set.
     * @param _validator The address of the validator.
     * @return TRUE iff `_validator` is enrolled in the validator set.
     */
    function isValidator(address _validator) public view returns (bool) {
        return validatorSet.contains(_validator);
    }

    /**
     * @notice Returns the number of validators enrolled in the validator set.
     * @return The number of validators enrolled in the validator set.
     */
    function validatorCount() public view returns (uint256) {
        return validatorSet.length();
    }

    // ============ Internal Functions ============

    /**
     * @notice Recovers the signer from a signature of a checkpoint.
     * @param _root The checkpoint's merkle root.
     * @param _index The checkpoint's index.
     * @param _signature Signature on the the checkpoint.
     * @return The signer of the checkpoint signature.
     **/
    function _recoverCheckpointSigner(
        bytes32 _root,
        uint256 _index,
        bytes calldata _signature
    ) internal view returns (address) {
        bytes32 _digest = keccak256(
            abi.encodePacked(domainHash, _root, _index)
        );
        return ECDSA.recover(ECDSA.toEthSignedMessageHash(_digest), _signature);
    }

    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function _enrollValidator(address _validator) internal {
        require(validatorSet.add(_validator), "already enrolled");
        emit EnrollValidator(_validator, validatorCount());
        validatorsCommitment = keccak256(
            abi.encodePacked(validatorsCommitment, _validator)
        );
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if the resulting validator set length is less than
     * the quorum threshold.
     * @dev Reverts if `_validator` is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function _unenrollValidator(address _validator) internal {
        require(validatorSet.remove(_validator), "!enrolled");
        uint256 _numValidators = validatorCount();
        require(_numValidators >= threshold, "violates quorum threshold");
        emit UnenrollValidator(_validator, _numValidators);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _threshold The new quorum threshold.
     */
    function _setThreshold(uint256 _threshold) internal {
        require(_threshold > 0 && _threshold <= validatorCount(), "!range");
        threshold = _threshold;
        emit SetThreshold(_threshold);
    }

    /**
     * @notice Hash of `_domain` concatenated with "ABACUS".
     * @param _domain The domain to hash.
     */
    function _domainHash(uint32 _domain) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_domain, "ABACUS"));
    }
}
