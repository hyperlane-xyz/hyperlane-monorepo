// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IValidatorAnnounce} from "./interfaces/IValidatorAnnounce.sol";
import {IMailbox} from "./interfaces/IMailbox.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";
import {ValidatorAnnouncements} from "./libs/ValidatorAnnouncements.sol";
// ============ External Imports ============
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title ValidatorAnnounce
 * @notice Stores the location(s) of validator signed checkpoints
 */
contract ValidatorAnnounce is IValidatorAnnounce {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;
    using TypeCasts for address;

    // ============ Constants ============

    // Address of the mailbox being validated
    address public immutable mailbox;
    // Domain of chain on which the contract is deployed
    uint32 public immutable localDomain;

    // ============ Public Storage ============

    // The set of validators that have announced
    EnumerableSet.AddressSet private validators;
    // Storage locations of validator signed checkpoints
    mapping(address => string[]) private storageLocations;
    // Mapping to prevent the same announcement from being registered
    // multiple times.
    mapping(bytes32 => bool) private replayProtection;

    // ============ Events ============

    /**
     * @notice Emitted when a new validator announcement is made
     * @param validator The address of the announcing validator
     * @param storageLocation The storage location being announced
     */
    event ValidatorAnnouncement(
        address indexed validator,
        string storageLocation
    );

    // ============ Constructor ============

    constructor(address _mailbox) {
        mailbox = _mailbox;
        localDomain = IMailbox(mailbox).localDomain();
    }

    // ============ External Functions ============

    /**
     * @notice Announces a validator signature storage location
     * @param _storageLocation Information encoding the location of signed
     * checkpoints
     * @param _signature The signed validator announcement
     * @return True upon success
     */
    function announce(
        address _validator,
        string calldata _storageLocation,
        bytes calldata _signature
    ) external returns (bool) {
        // Ensure that the same storage metadata isn't being announced
        // multiple times for the same validator.
        bytes32 _replayId = keccak256(
            abi.encodePacked(_validator, _storageLocation)
        );
        require(replayProtection[_replayId] == false, "replay");
        replayProtection[_replayId] = true;

        // Verify that the signature matches the declared validator
        bytes32 _announcementDigest = ValidatorAnnouncements
            .getAnnouncementDigest(mailbox, localDomain, _storageLocation);
        address _signer = ECDSA.recover(_announcementDigest, _signature);
        require(_signer == _validator, "!signature");

        // Store the announcement
        if (!validators.contains(_validator)) {
            validators.add(_validator);
        }
        storageLocations[_validator].push(_storageLocation);
        emit ValidatorAnnouncement(_validator, _storageLocation);
        return true;
    }

    /**
     * @notice Returns a list of all announced storage locations
     * @param _validators The list of validators to get registrations for
     * @return A list of registered storage metadata
     */
    function getAnnouncedStorageLocations(address[] calldata _validators)
        external
        view
        returns (string[][] memory)
    {
        string[][] memory _metadata = new string[][](_validators.length);
        for (uint256 i = 0; i < _validators.length; i++) {
            _metadata[i] = storageLocations[_validators[i]];
        }
        return _metadata;
    }

    /// @notice Returns a list of validators that have made announcements
    function getAnnouncedValidators() external view returns (address[] memory) {
        return validators.values();
    }
}
