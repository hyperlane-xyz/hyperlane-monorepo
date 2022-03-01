// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IValidatorManager} from "../interfaces/IValidatorManager.sol";
import {Home} from "./Home.sol";
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
     * @notice Emitted when an validator is set
     * @param domain The domain for which the validator is being set
     * @param validator The address of the validator
     */
    event NewValidator(uint32 indexed domain, address indexed validator);

    /**
     * @notice Emitted when proof of an improper update is submitted,
     * which sets the contract to FAILED state
     * @param root Root of the improper update
     * @param index Index of the improper update
     * @param signature Signature on `root` and `index`
     */
    event ImproperUpdate(
        address indexed home,
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
     * @notice Set the address of a new validator
     * @dev only callable by trusted owner
     * @param _domain The domain for which the validator is being set
     * @param _validator The address of the validator
     */
    function setValidator(uint32 _domain, address _validator) external onlyOwner {
        validators[_domain] = _validator;
        emit NewValidator(_domain, _validator);
    }

    /**
     * @notice Check if an Update is an Improper Update;
     * if so, set the provided Home contract to FAILED state.
     *
     * An Improper Update is an update that was not previously checkpointed.
     * @param _home Address of the Home contract to set to FAILED.
     * @param _root Merkle root of the improper update
     * @param _index Index root of the improper update
     * @param _signature Validator signature on `_root` and `_index`
     * @return TRUE if update was an Improper Update (implying Validator was slashed)
     */
    function improperUpdate(
        address _home,
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) external returns (bool) {
        uint32 _domain = Home(_home).localDomain();
        require(
            isValidatorSignature(_domain, _root, _index, _signature),
            "!validator sig"
        );
        require(Home(_home).checkpoints(_root) != _index, "!improper");
        Home(_home).fail();
        emit ImproperUpdate(
            _home,
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
     * @param _domain Domain of Home contract
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
     * @notice Hash of domain concatenated with "ABACUS"
     * @param _domain the domain to hash
     */
    function domainHash(uint32 _domain) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_domain, "ABACUS"));
    }
}
