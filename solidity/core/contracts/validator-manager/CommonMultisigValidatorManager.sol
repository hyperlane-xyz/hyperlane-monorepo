// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma abicoder v2;

// ============ Internal Imports ============
import {Inbox} from "../Inbox.sol";
import {Outbox} from "../Outbox.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/EnumerableSet.sol";

contract CommonMultisigValidatorManager is Ownable {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;

    // ============ Immutables ============

    // The domain of the outbox the set of validators this validator manager
    // tracks is for.
    uint32 public immutable outboxDomain;

    bytes32 public immutable outboxDomainHash;

    // ============ Mutable Storage ============

    // The minimum threshold of validator signatures to constitute a quorum
    uint256 public threshold;

    // The set of validators
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
     * @param threshold The quorum threshold.
     */
    event SetThreshold(uint256 threshold);

    /**
     * @notice Emitted when proof of an improper checkpoint is submitted.
     * @param root Root of the improper checkpoint.
     * @param index Index of the improper checkpoint.
     * @param signatures A quorum of signatures on the improper checkpoint.
     */
    event ImproperCheckpoint(
        address indexed outbox,
        bytes32 indexed root,
        uint256 index,
        bytes[] signatures
    );

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

    // Adds _validator to validators
    function enrollValidator(address _validator) external onlyOwner {
        // Revert if _validator is already an enrolled validator.
        require(validators.add(_validator), "!unenrolled");
        emit EnrollValidator(_validator);
    }

    // Removes _validator from validators
    function unenrollValidator(address _validator) external onlyOwner {
        // Revert if _validator is not an already enrolled validator.
        require(validators.remove(_validator), "!enrolled");
        emit UnenrollValidator(_validator);
    }

    function setThreshold(uint256 _threshold) external onlyOwner {
        threshold = _threshold;
        emit SetThreshold(_threshold);
    }

    // Gets the domain from IInbox(_inbox).localDomain(), then
    // requires isQuorum(domain, _root, _index, _signatures),
    // and then calls IInbox(_inbox).checkpoint(_root, _index);
    function checkpoint(
        Inbox _inbox,
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures
    ) external {
        require(isQuorum(_root, _index, _signatures), "!quorum");
        _inbox.checkpoint(_root, _index);
    }

    // Determines if a quorum of signers have signed an improper checkpoint,
    // and fails the Outbox if so.
    // If staking / slashing existed, we'd want to check this for individual validator
    // signatures. Because we don't care about that and we don't want a single byzantine
    // validator to be able to fail the outbox, we require a quorum.
    //
    // Gets the domain from IOutbox(_outbox).localDomain(), then
    // requires isQuorum(domain, _root, _index, _signatures),
    // requires that the checkpoint is an improper checkpoint,
    // and calls IOutbox(_outbox).fail(). (Similar behavior as existing improperCheckpoint)
    function improperCheckpoint(
        Outbox _outbox,
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures
    ) external {
        require(isQuorum(_root, _index, _signatures), "!quorum");
        require(!_outbox.isCheckpoint(_root, _index), "!improper checkpoint");
        _outbox.fail();
        emit ImproperCheckpoint(address(_outbox), _root, _index, _signatures);
    }

    // Just returns the addresses in the private enumerable set `validators`.
    function validatorSet() external view returns (address[] memory) {
        uint256 _length = validators.length();
        address[] memory _validatorSet = new address[](_length);
        for (uint256 i = 0; i < _length; i++) {
            _validatorSet[i] = validators.at(i);
        }
        return _validatorSet;
    }

    // ============ Public Functions ============

    // Returns whether the provided signatures over the checkpoint for the domain
    // constitute a quorum of validator signatures.
    // Requires each signature to be over the given domain, root, and index.
    // Requires _signatures to be sorted by their recovered signer's address for duplicate detection.
    // Requires each recovered signer to be in the `validators` set.
    // Requires _signatures.length to be >= threshold.
    function isQuorum(
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures
    ) public view returns (bool) {
        uint256 _signaturesLength = _signatures.length;
        // If there are less signatures provided than the required threshold,
        // this is not a quorum.
        if (_signaturesLength < threshold) {
            return false;
        }
        // To identify duplicates, the signers recovered from _signatures
        // must be sorted in ascending order. previousSigner is used to
        // enforce sort order.
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
        }
        return _validatorSignatureCount >= threshold;
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
