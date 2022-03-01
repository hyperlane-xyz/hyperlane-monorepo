// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {Outbox} from "./Outbox.sol";
import {Inbox} from "./Inbox.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title XAppConnectionManager
 * @author Celo Labs Inc.
 * @notice Manages a registry of local Inbox contracts for remote Outbox
 * domains.
 */
contract XAppConnectionManager is Ownable {
    // ============ Public Storage ============

    // Outbox contract
    Outbox public outbox;
    // local Inbox address => remote Outbox domain
    mapping(address => uint32) public inboxToDomain;
    // remote Outbox domain => local Inbox address
    mapping(uint32 => address) public domainToInbox;

    // ============ Events ============

    /**
     * @notice Emitted when a new Outbox is set.
     * @param outbox the address of the Outbox
     */
    event NewOutbox(address indexed outbox);

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
     * @notice Set the address of the local Outbox contract
     * @param _outbox the address of the local Outbox contract
     */
    function setOutbox(address _outbox) external onlyOwner {
        outbox = Outbox(_outbox);
        emit NewOutbox(_outbox);
    }

    /**
     * @notice Allow Owner to enroll Inbox contract
     * @param _inbox the address of the Inbox
     * @param _domain the remote domain of the Outbox contract for the Inbox
     */
    function enrollInbox(address _inbox, uint32 _domain)
        external
        onlyOwner
    {
        // un-enroll any existing inbox
        _unenrollInbox(_inbox);
        // add inbox and domain to two-way mapping
        inboxToDomain[_inbox] = _domain;
        domainToInbox[_domain] = _inbox;
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
    function localDomain() external view returns (uint32) {
        return outbox.localDomain();
    }

    // ============ Public Functions ============

    /**
     * @notice Check whether _inbox is enrolled
     * @param _inbox the inbox to check for enrollment
     * @return TRUE iff _inbox is enrolled
     */
    function isInbox(address _inbox) public view returns (bool) {
        return inboxToDomain[_inbox] != 0;
    }

    // ============ Internal Functions ============

    /**
     * @notice Remove the inbox from the two-way mappings
     * @param _inbox inbox to un-enroll
     */
    function _unenrollInbox(address _inbox) internal {
        uint32 _currentDomain = inboxToDomain[_inbox];
        domainToInbox[_currentDomain] = address(0);
        inboxToDomain[_inbox] = 0;
        emit InboxUnenrolled(_currentDomain, _inbox);
    }
}
