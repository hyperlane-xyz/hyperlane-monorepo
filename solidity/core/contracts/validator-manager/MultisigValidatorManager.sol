// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma abicoder v2;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/EnumerableSet.sol";

/**
 * @notice Manages an ownable validator set that sign checkpoints with
 * a basic ECDSA multi-signature.
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
     * @notice Emitted when a validator is unenrolled in the validator set.
     * @param validator The address of the validator.
     */
    event UnenrollValidator(address indexed validator);

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param quorumThreshold The quorum threshold.
     */
    event SetQuorumThreshold(uint256 quorumThreshold);

    // ============ Constructor ============

    /**
     * @param _outboxDomain The domain of the outbox this validator manager
     * tracks the validator set for.
     */
    constructor(uint32 _outboxDomain) Ownable() {
        outboxDomain = _outboxDomain;
        outboxDomainHash = keccak256(abi.encodePacked(_outboxDomain, "ABACUS"));
    }

    // ============ External Functions ============

    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if _validator is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function enrollValidator(address _validator) external onlyOwner {
        require(validators.add(_validator), "enrolled");
        emit EnrollValidator(_validator);
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if _validator is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function unenrollValidator(address _validator) external onlyOwner {
        require(validators.remove(_validator), "!enrolled");
        emit UnenrollValidator(_validator);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _quorumThreshold The new quorum threshold.
     */
    function setQuorumThreshold(uint256 _quorumThreshold) external onlyOwner {
        require(
            _quorumThreshold > 0 && _quorumThreshold <= validators.length(),
            "!range"
        );
        quorumThreshold = _quorumThreshold;
        emit SetQuorumThreshold(_quorumThreshold);
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
            address _signer = recoverCheckpointSigner(
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

    // ============ Internal Functions ============

    /**
     * @notice Recovers the signer from a signature of a checkpoint.
     * @param _root The checkpoint's merkle root.
     * @param _index The checkpoint's index.
     * @param _signature Signature on the the checkpoint.
     * @return The signer of the checkpoint signature.
     **/
    function recoverCheckpointSigner(
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
}
