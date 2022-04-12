// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma abicoder v2;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/EnumerableSet.sol";

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
    uint32 public immutable outboxDomain;

    // The domain hash of the validator set's outbox chain.
    bytes32 public immutable outboxDomainHash;

    // ============ Mutable Storage ============

    // The minimum threshold of validator signatures to constitute a quorum.
    uint256 public quorumThreshold;

    // The set of validators.
    EnumerableSet.AddressSet private validators;

    // ============ Events ============

    /**
     * @notice Emitted when a validator is enrolled in the validator set.
     * @param validator The address of the validator.
     */
    event EnrollValidator(address indexed validator);

    /**
     * @notice Emitted when a validator is unenrolled from the validator set.
     * @param validator The address of the validator.
     */
    event UnenrollValidator(address indexed validator);

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param quorumThreshold The new quorum threshold.
     */
    event SetQuorumThreshold(uint256 quorumThreshold);

    // ============ Constructor ============

    /**
     * @param _outboxDomain The domain of the outbox the validator set is for.
     * @param _validatorSet The set of validator addresses.
     * @param _quorumThreshold The quorum threshold. Must be greater than or equal
     * to the length of _validatorSet.
     */
    constructor(
        uint32 _outboxDomain,
        address[] memory _validatorSet,
        uint256 _quorumThreshold
    ) Ownable() {
        // Set immutables.
        outboxDomain = _outboxDomain;
        outboxDomainHash = domainHash(_outboxDomain);

        // Enroll validators. Reverts if there are any duplicates.
        uint256 _validatorSetLength = _validatorSet.length;
        for (uint256 i = 0; i < _validatorSetLength; i++) {
            _enrollValidator(_validatorSet[i]);
        }

        _setQuorumThreshold(_quorumThreshold);
    }

    // ============ External Functions ============

    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if _validator is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function enrollValidator(address _validator) external onlyOwner {
        _enrollValidator(_validator);
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if _validator is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function unenrollValidator(address _validator) external onlyOwner {
        _unenrollValidator(_validator);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _quorumThreshold The new quorum threshold.
     */
    function setQuorumThreshold(uint256 _quorumThreshold) external onlyOwner {
        _setQuorumThreshold(_quorumThreshold);
    }

    /**
     * @notice Gets the addresses of the current validator set.
     * @dev There ordering guarantee due to the semantics of EnumerableSet.AddressSet.
     * @return The addresses of the validator set.
     */
    function validatorSet() external view returns (address[] memory) {
        uint256 _length = validators.length();
        address[] memory _validatorSet = new address[](_length);
        for (uint256 i = 0; i < _length; i++) {
            _validatorSet[i] = validators.at(i);
        }
        return _validatorSet;
    }

    // ============ Public Functions ============

    /**
     * @notice Returns whether provided signatures over a checkpoint constitute
     * a quorum of validator signatures.
     * @dev Reverts if _signatures is not sorted in ascending order by the signer
     * address, which is required for duplicate detection.
     * @dev Does not revert if a signature's signer is not in the validator set.
     * @param _root The merkle root of the checkpoint.
     * @param _index The index of the checkpoint.
     * @param _signatures Signatures over the checkpoint to be checked for a validator
     * quorum. Must be sorted in ascending order by signer address.
     * @return TRUE iff _signatures constitute a quorum of validator signatures over
     * the checkpoint.
     */
    function isQuorum(
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures
    ) public view returns (bool) {
        uint256 _signaturesLength = _signatures.length;
        // If there are less signatures provided than the required quorum threshold,
        // this is not a quorum.
        if (_signaturesLength < quorumThreshold) {
            return false;
        }
        // To identify duplicates, the signers recovered from _signatures
        // must be sorted in ascending order. previousSigner is used to
        // enforce ordering.
        address _previousSigner = address(0);
        uint256 _validatorSignatureCount = 0;
        for (uint256 i = 0; i < _signaturesLength; i++) {
            address _signer = _recoverCheckpointSigner(
                _root,
                _index,
                _signatures[i]
            );
            // Revert if the signer violates the required sort order.
            require(_previousSigner < _signer, "!sorted signers");
            // If the signer is a validator, increment _validatorSignatureCount.
            if (validators.contains(_signer)) {
                _validatorSignatureCount++;
            }
            _previousSigner = _signer;
        }
        return _validatorSignatureCount >= quorumThreshold;
    }

    /**
     * @notice Hash of domain concatenated with "ABACUS".
     * @param _domain The domain to hash.
     */
    function domainHash(uint32 _domain) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_domain, "ABACUS"));
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
            abi.encodePacked(outboxDomainHash, _root, _index)
        );
        _digest = ECDSA.toEthSignedMessageHash(_digest);
        return ECDSA.recover(_digest, _signature);
    }

    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if _validator is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function _enrollValidator(address _validator) internal {
        require(validators.add(_validator), "already enrolled");
        emit EnrollValidator(_validator);
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if the resulting validator set length is less than
     * the quorum threshold.
     * @dev Reverts if _validator is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function _unenrollValidator(address _validator) internal {
        require(
            validators.length() > quorumThreshold,
            "violates quorum threshold"
        );
        require(validators.remove(_validator), "!enrolled");
        emit UnenrollValidator(_validator);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _quorumThreshold The new quorum threshold.
     */
    function _setQuorumThreshold(uint256 _quorumThreshold) internal {
        require(
            _quorumThreshold > 0 && _quorumThreshold <= validators.length(),
            "!range"
        );
        quorumThreshold = _quorumThreshold;
        emit SetQuorumThreshold(_quorumThreshold);
    }
}
