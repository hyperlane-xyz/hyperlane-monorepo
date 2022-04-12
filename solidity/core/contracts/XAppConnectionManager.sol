// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IOutbox} from "../interfaces/IOutbox.sol";
import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
// ============ External Imports ============
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
    IOutbox public outbox;
    // Interchain Gas Paymaster contract. The off-chain processor associated with
    // the paymaster contract must be willing to process messages dispatched from
    // the current Outbox contract, otherwise payments made to the paymaster will
    // not result in processed messages.
    IInterchainGasPaymaster public interchainGasPaymaster;
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
     * @notice Emitted when a new Interchain Gas Paymaster is set.
     * @param interchainGasPaymaster The address of the Interchain Gas Paymaster.
     */
    event NewInterchainGasPaymaster(address indexed interchainGasPaymaster);

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
     * @notice Sets the address of the local Outbox contract and the address of
     * the local Interchain Gas Paymaster contract.
     * @dev This should be used to atomically change the local Outbox and Interchain Gas Paymaster.
     * @param _outbox The address of the new local Outbox contract.
     * @param _interchainGasPaymaster The address of the new local Interchain Gas Paymaster contract.
     */
    function setOutboxAndInterchainGasPaymaster(
        address _outbox,
        address _interchainGasPaymaster
    ) external onlyOwner {
        setOutbox(_outbox);
        setInterchainGasPaymaster(_interchainGasPaymaster);
    }

    /**
     * @notice Allow Owner to enroll Inbox contract
     * @param _domain the remote domain of the Outbox contract for the Inbox
     * @param _inbox the address of the Inbox
     */
    function enrollInbox(uint32 _domain, address _inbox) external onlyOwner {
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
     * @notice Sets the address of the local Outbox contract.
     * @dev Changing the Outbox and not the Interchain Gas Paymaster may result in
     * using an Interchain Gas Paymaster that expects messages to be dispatched via
     * a different outbox. Use `setOutboxAndInterchainGasPaymaster` to change both
     * atomically.
     * @param _outbox The address of the new local Outbox contract.
     */
    function setOutbox(address _outbox) public onlyOwner {
        outbox = IOutbox(_outbox);
        emit NewOutbox(_outbox);
    }

    /**
     * @notice Sets the address of the local Interchain Gas Paymaster contract.
     * @param _interchainGasPaymaster The address of the new local Interchain Gas Paymaster contract.
     */
    function setInterchainGasPaymaster(address _interchainGasPaymaster)
        public
        onlyOwner
    {
        interchainGasPaymaster = IInterchainGasPaymaster(
            _interchainGasPaymaster
        );
        emit NewInterchainGasPaymaster(_interchainGasPaymaster);
    }

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
