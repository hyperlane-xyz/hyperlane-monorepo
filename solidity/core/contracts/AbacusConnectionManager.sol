// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IOutbox} from "../interfaces/IOutbox.sol";
import {IInbox} from "../interfaces/IInbox.sol";
import {IAbacusConnectionManager} from "../interfaces/IAbacusConnectionManager.sol";
import {IMultisigValidatorManager} from "../interfaces/IMultisigValidatorManager.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title AbacusConnectionManager
 * @author Celo Labs Inc.
 * @notice Manages a registry of local Inbox contracts for remote Outbox
 * domains.
 */
contract AbacusConnectionManager is IAbacusConnectionManager, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // ============ Public Storage ============

    // Outbox contract
    IOutbox public override outbox;
    // local Inbox address => remote Outbox domain
    mapping(address => uint32) public inboxToDomain;
    // remote Outbox domain => local Inbox addresses
    mapping(uint32 => EnumerableSet.AddressSet) domainToInboxes;
    // complete history of enrolled inbox domain hashes, even if unenrolled
    EnumerableSet.Bytes32Set domainHashes;

    // ============ Events ============

    /**
     * @notice Emitted when a new Outbox is set.
     * @param outbox the address of the Outbox
     */
    event OutboxSet(address indexed outbox);

    /**
     * @notice Emitted when a new Inbox is enrolled / added
     * @param domain the remote domain of the Outbox contract for the Inbox
     * @param inbox the address of the Inbox
     */
    event InboxEnrolled(uint32 indexed domain, address inbox);

    /**
     * @notice Emitted when a new Inbox is un-enrolled / removed
     * @param domain the remote domain of the Outbox contract for the Inbox
     * @param inbox the address of the Inbox
     */
    event InboxUnenrolled(uint32 indexed domain, address inbox);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Sets the address of the local Outbox contract.
     * @param _outbox The address of the new local Outbox contract.
     */
    function setOutbox(address _outbox) external onlyOwner {
        outbox = IOutbox(_outbox);
        emit OutboxSet(_outbox);
    }

    /**
     * @notice Allow Owner to enroll Inbox contract
     * @param _domain the remote domain of the Outbox contract for the Inbox
     * @param _inbox the address of the Inbox
     */
    function enrollInbox(uint32 _domain, address _inbox) external onlyOwner {
        require(!isInbox(_inbox), "already inbox");

        // prevent enrolling an inbox that matches any previously enrolled domain hash
        bytes32 domainHash = getDomainHash(_inbox);
        require(
            !domainHashes.contains(domainHash),
            "domain hash previously enrolled"
        );
        domainHashes.add(domainHash);

        // add inbox and domain to two-way mapping
        inboxToDomain[_inbox] = _domain;
        domainToInboxes[_domain].add(_inbox);
        emit InboxEnrolled(_domain, _inbox);
    }

    /**
     * @notice Allow Owner to un-enroll Inbox contract
     * @param _inbox the address of the Inbox
     */
    function unenrollInbox(address _inbox) external onlyOwner {
        _unenrollInbox(_inbox);
    }

    /**
     * @notice Query local domain from Outbox
     * @return local domain
     */
    function localDomain() external view override returns (uint32) {
        return outbox.localDomain();
    }

    /**
     * @notice Returns the Inbox addresses for a given remote domain
     * @return inboxes An array of addresses of the Inboxes
     */
    function getInboxes(uint32 remoteDomain)
        external
        view
        returns (address[] memory)
    {
        EnumerableSet.AddressSet storage _inboxes = domainToInboxes[
            remoteDomain
        ];
        uint256 length = _inboxes.length();
        address[] memory ret = new address[](length);
        for (uint256 i = 0; i < length; i += 1) {
            ret[i] = _inboxes.at(i);
        }
        return ret;
    }

    // ============ Public Functions ============

    /**
     * @notice Check whether _inbox is enrolled
     * @param _inbox the inbox to check for enrollment
     * @return TRUE iff _inbox is enrolled
     */
    function isInbox(address _inbox) public view override returns (bool) {
        return inboxToDomain[_inbox] != 0;
    }

    /**
     * @notice Check whether _inbox is enrolled
     * @param _inbox the inbox to check for enrollment
     * @return TRUE iff _inbox is enrolled
     */
    function getDomainHash(address _inbox) public view returns (bytes32) {
        IInbox inbox = IInbox(_inbox);
        address vm = inbox.validatorManager();
        return IMultisigValidatorManager(vm).domainHash();
    }

    // ============ Internal Functions ============

    /**
     * @notice Remove the inbox from the two-way mappings
     * @param _inbox inbox to un-enroll
     */
    function _unenrollInbox(address _inbox) internal {
        uint32 _currentDomain = inboxToDomain[_inbox];
        domainToInboxes[_currentDomain].remove(_inbox);
        inboxToDomain[_inbox] = 0;
        emit InboxUnenrolled(_currentDomain, _inbox);
    }
}
