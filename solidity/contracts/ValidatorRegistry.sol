// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IValidatorRegistry} from "../interfaces/IValidatorRegistry.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";
// ============ External Imports ============
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title ValidatorRegistry
 * @notice Stores the location of validator signed checkpoints
 */
contract ValidatorRegistry is IValidatorRegistry {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;
    using TypeCasts for address;

    // ============ Constants ============

    // Address of the mailbox being validated
    address public immutable mailbox;
    // Domain of chain on which the contract is deployed
    uint32 public immutable localDomain;

    // ============ Public Storage ============

    // The set of validators that have registered
    EnumerableSet.AddressSet private registeredValidators;
    // Storage locations of validator signed checkpoints
    mapping(address => string[]) private storageMetadata;
    // Mapping to prevent the same announcement from being registered
    // multiple times.
    mapping(bytes32 => bool) private replayProtection;

    // ============ Events ============

    // ============ Constructor ============

    constructor(address _mailbox) {
        mailbox = _mailbox;
        localDomain = IMailbox(mailbox).localDomain();
    }

    // ============ External Functions ============

    /**
     * @notice Registers a validator
     * @param _storageMetadata Information encoding the location of signed
     * checkpoints
     * @param _signature The signed validator announcement attestation
     * previously specified in this HIP
     * @return True upon success
     */
    function registerValidator(
        address _validator,
        string calldata _storageMetadata,
        bytes calldata _signature
    ) external returns (bool) {
        // Ensure that the same storage metadata isn't being registered
        // multiple times for the same validator.
        bytes32 _replayId = keccak256(
            abi.encodePacked(_validator, _storageMetadata)
        );
        require(replayProtection[_replayId] == false, "replay");
        replayProtection[_replayId] = true;

        // Verify that the signature matches the declared validator
        bytes32 _announcementDigest = _getAnnouncementDigest(_storageMetadata);
        address _signer = ECDSA.recover(_announcementDigest, _signature);
        require(_signer == _validator, "!signature");

        // Register the announcement
        if (!registeredValidators.contains(_signer)) {
            registeredValidators.add(_signer);
        }
        storageMetadata[_signer].push(_storageMetadata);
        return true;
    }

    /**
     * @notice Returns a list of all registrations for all provided validators
     * @param _validators The list of validators to get registrations for
     * @return A list of registered storage metadata
     */
    function getValidatorRegistrations(address[] calldata _validators)
        external
        view
        returns (string[][] memory)
    {
        string[][] memory _metadata = new string[][](_validators.length);
        for (uint256 i = 0; i < _validators.length; i++) {
            _metadata[i] = storageMetadata[_validators[i]];
        }
        return _metadata;
    }

    /// @notice Returns a list of validators that have registered
    function validators() external view returns (address[] memory) {
        uint256 _validatorCount = registeredValidators.length();
        address[] memory _validators = new address[](_validatorCount);
        for (uint256 i = 0; i < _validatorCount; i++) {
            _validators[i] = registeredValidators.at(i);
        }
        return _validators;
    }

    // ============ Internal Functions ============

    /**
     * @notice Returns the digest validators are expected to sign when signing announcements.
     * @param _metadata Storage metadata string.
     * @return The digest of the checkpoint.
     */
    function _getAnnouncementDigest(string calldata _metadata)
        internal
        view
        returns (bytes32)
    {
        bytes32 _domainHash = keccak256(
            abi.encodePacked(
                localDomain,
                mailbox.addressToBytes32(),
                "HYPERLANE"
            )
        );
        return
            ECDSA.toEthSignedMessageHash(
                keccak256(abi.encodePacked(_domainHash, _metadata))
            );
    }
}
