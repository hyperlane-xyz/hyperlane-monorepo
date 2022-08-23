// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IOutbox} from "../interfaces/IOutbox.sol";
import {IAbacusConnectionManager} from "../interfaces/IAbacusConnectionManager.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title AbacusConnectionManager
 * @author Celo Labs Inc.
 * @notice Manages a registry of local Inbox contracts for remote Outbox
 * domains.
 */
contract AbacusConnectionManager is IAbacusConnectionManager, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ============ Public Storage ============

    // Outbox contract
    IOutbox public override outbox;
    // local Inbox address => remote Outbox domain
    mapping(address => uint32) public inboxToDomain;
    // remote Outbox domain => local Inbox addresses
    mapping(uint32 => EnumerableSet.AddressSet) domainToInboxes;

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
        require(Address.isContract(_outbox), "outbox !contract");
        outbox = IOutbox(_outbox);
        emit OutboxSet(_outbox);
    }

    /**
     * @notice Allow Owner to enroll Inbox contract
     * @param _domain the remote domain of the Outbox contract for the Inbox
     * @param _inbox the address of the Inbox
     */
    function enrollInbox(uint32 _domain, address _inbox) external onlyOwner {
        require(Address.isContract(_inbox), "inbox !contract");
        require(!isInbox(_inbox), "already inbox");
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
