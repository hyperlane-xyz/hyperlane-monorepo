// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IValidatorManager} from "../interfaces/IValidatorManager.sol";
import {Outbox} from "./Outbox.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/cryptography/ECDSA.sol";

/**
 * @title ValidatorManager
 * @author Celo Labs Inc.
 * @notice MVP version of contract that will manage Validator selection and
 * rotataion.
 */
contract ValidatorManager is IValidatorManager, Ownable {
    // Mapping of domain -> validator address.
    mapping(uint32 => address) public validators;

    // ============ Events ============

    /**
     * @notice Emitted when a validator is enrolled
     * @param domain The domain for which the validator is being enrolled
     * @param validator The address of the validator
     */
    event ValidatorEnrolled(uint32 indexed domain, address indexed validator);

    /**
     * @notice Emitted when proof of an improper checkpoint is submitted,
     * which sets the contract to FAILED state
     * @param root Root of the improper checkpoint
     * @param index Index of the improper checkpoint
     * @param signature Signature on `root` and `index`
     */
    event ImproperCheckpoint(
        address indexed outbox,
        uint32 indexed domain,
        address indexed validator,
        bytes32 root,
        uint256 index,
        bytes signature
    );

    // ============ Constructor ============

    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Enroll a validator for the given domain
     * @dev only callable by trusted owner
     * @param _domain The domain for which the validator is being set
     * @param _validator The address of the validator
     */
    function enrollValidator(uint32 _domain, address _validator)
        external
        onlyOwner
    {
        validators[_domain] = _validator;
        emit ValidatorEnrolled(_domain, _validator);
    }

    /**
     * @notice Check if an Checkpoint is an Improper Checkpoint;
     * if so, set the provided Outbox contract to FAILED state.
     *
     * An Improper Checkpoint is an checkpoint that was not previously checkpointed.
     * @param _outbox Address of the Outbox contract to set to FAILED.
     * @param _root Merkle root of the improper checkpoint
     * @param _index Index root of the improper checkpoint
     * @param _signature Validator signature on `_root` and `_index`
     * @return TRUE if checkpoint was an Improper Checkpoint (implying Validator was slashed)
     */
    function improperCheckpoint(
        address _outbox,
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) external returns (bool) {
        uint32 _domain = Outbox(_outbox).localDomain();
        require(
            isValidatorSignature(_domain, _root, _index, _signature),
            "!validator sig"
        );
        require(Outbox(_outbox).checkpoints(_root) != _index, "!improper");
        Outbox(_outbox).fail();
        emit ImproperCheckpoint(
            _outbox,
            _domain,
            validators[_domain],
            _root,
            _index,
            _signature
        );
        return true;
    }

    // ============ Public Functions ============

    /**
     * @notice Checks that signature was signed by Validator
     * @param _domain Domain of Outbox contract
     * @param _root Merkle root
     * @param _index Corresponding leaf index
     * @param _signature Signature on `_root` and `_index`
     * @return TRUE iff signature is valid signed by validator
     **/
    function isValidatorSignature(
        uint32 _domain,
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) public view override returns (bool) {
        bytes32 _digest = keccak256(
            abi.encodePacked(domainHash(_domain), _root, _index)
        );
        _digest = ECDSA.toEthSignedMessageHash(_digest);
        return (ECDSA.recover(_digest, _signature) == validators[_domain]);
    }

    /**
     * @notice Hash of domain concatenated with "OPTICS"
     * @param _domain the domain to hash
     */
    function domainHash(uint32 _domain) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_domain, "OPTICS"));
    }
}
