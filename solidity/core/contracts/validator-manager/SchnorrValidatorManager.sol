// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BN256} from "../../libs/BN256.sol";

/**
 * @title MultisigValidatorManager
 * @notice Manages an ownable set of validators that ECDSA sign checkpoints to
 * reach a quorum.
 */
abstract contract SchnorrValidatorManager is Ownable {
    // ============ Libraries ============

    using BN256 for BN256.G1Point;

    // The domain of the validator set's outbox chain.
    uint32 public immutable domain;

    // The domain hash of the validator set's outbox chain.
    bytes32 public immutable domainHash;

    // ============ Mutable Storage ============

    // The minimum maximum number of missing validators that still constitutes a quorum.
    uint256 public threshold;

    // What do the destination chains need to know?
    //   a) Aggregated public key
    //   b) Mapping of public key (or negation) => bool
    // We can track this by sending (added keys, removed keys), the InboxValidatorManager
    // simply sets/clears the membership mapping and updates the aggregate key.

    // The aggregated public key of all validators.
    BN256.G1Point public aggregatedPublicKey;
    // Mapping of validatorPublicKey.compress() => negative Y value.
    mapping(bytes32 => bytes32) public _negativeY;

    // ============ Events ============

    /**
     * @notice Emitted when a validator is enrolled in the validator set.
     */
    event EnrollValidator(
        BN256.G1Point indexed validator,
        BN256.G1Point indexed publicKey
    );

    /**
     * @notice Emitted when a validator is unenrolled from the validator set.
     */
    event UnenrollValidator(
        BN256.G1Point indexed validator,
        BN256.G1Point indexed publicKey
    );

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
        BN256.G1Point[] memory _validators,
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
    function enrollValidator(BN256.G1Point calldata _validator)
        external
        onlyOwner
    {
        _enrollValidator(_validator);
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if `_validator` is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function unenrollValidator(BN256.G1Point calldata _validator)
        external
        onlyOwner
    {
        _unenrollValidator(_validator);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _threshold The new quorum threshold.
     */
    function setThreshold(uint256 _threshold) external onlyOwner {
        _setThreshold(_threshold);
    }

    // ============ Public Functions ============

    /**
     * @notice Returns if `_validator` is enrolled in the validator set.
     * @param _validator The address of the validator.
     * @return TRUE iff `_validator` is enrolled in the validator set.
     */
    function isEnrolled(BN256.G1Point memory _validator)
        public
        view
        returns (bool)
    {
        return _negativeY[_validator.compress()] != 0;
    }

    // ============ Internal Functions ============

    function verificationKey(bytes32[] calldata _compressedOmitted)
        public
        view
        returns (BN256.G1Point memory)
    {
        BN256.G1Point memory _publicKey = aggregatedPublicKey;
        for (uint256 i = 0; i < _compressedOmitted.length; i++) {
            bytes32 _compressed = _compressedOmitted[i];
            if (i + 1 < _compressedOmitted.length) {
                require(_compressed < _compressedOmitted[i + 1], "!sorted");
            }
            bytes32 _negY = _negativeY[_compressed];
            require(_negY > 0, "!validator");
            bytes32 _x = BN256.decompress(_compressed);
            BN256.G1Point memory _p = BN256.G1Point(_x, _negY);
            _publicKey = _publicKey.add(_p);
        }
        return _publicKey;
    }

    function verify(
        BN256.G1Point memory _publicKey,
        BN256.G1Point calldata _nonce,
        uint256 _signature,
        uint256 _challenge
    ) public view returns (bool) {
        BN256.G1Point memory _verification = _nonce.add(
            _publicKey.mul(_challenge)
        );
        return BN256.g().mul(_signature).eq(_verification);
    }

    // TODO: This function needs to verify a PoP to protect against rogue key attacks.
    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function _enrollValidator(BN256.G1Point memory _validator) internal {
        bytes32 compressed = _validator.compress();
        require(_negativeY[compressed] == 0, "enrolled");
        _negativeY[compressed] = _validator.neg().y;
        aggregatedPublicKey = aggregatedPublicKey.add(_validator);
        emit EnrollValidator(_validator, aggregatedPublicKey);
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if the resulting validator set length is less than
     * the quorum threshold.
     * @dev Reverts if `_validator` is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function _unenrollValidator(BN256.G1Point memory _validator) internal {
        bytes32 compressed = _validator.compress();
        require(_negativeY[compressed] != 0, "!enrolled");
        _negativeY[compressed] = 0;
        aggregatedPublicKey = aggregatedPublicKey.add(_validator.neg());
        emit UnenrollValidator(_validator, aggregatedPublicKey);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _threshold The new quorum threshold.
     */
    function _setThreshold(uint256 _threshold) internal {
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

    function ecAdd(BN256.G1Point memory a, BN256.G1Point memory b)
        external
        view
        returns (BN256.G1Point memory)
    {
        return a.add(b);
    }

    function ecMul(BN256.G1Point memory a, uint256 b)
        external
        view
        returns (BN256.G1Point memory)
    {
        return a.mul(b);
    }

    function ecGen(uint256 s) public view returns (BN256.G1Point memory) {
        return BN256.g().mul(s);
    }

    function ecNeg(BN256.G1Point memory a)
        public
        pure
        returns (BN256.G1Point memory)
    {
        return a.neg();
    }

    function ecCompress(BN256.G1Point memory a) public pure returns (bytes32) {
        return a.compress();
    }

    function scalarMod(uint256 a) public pure returns (uint256) {
        return BN256.mod(a);
    }

    function modAdd(uint256 a, uint256 b) public pure returns (uint256) {
        return BN256.add(a, b);
    }

    function modMul(uint256 a, uint256 b) public pure returns (uint256) {
        return BN256.mul(a, b);
    }
}
