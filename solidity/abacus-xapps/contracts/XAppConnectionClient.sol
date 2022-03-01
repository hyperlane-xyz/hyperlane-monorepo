// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import {Outbox} from "@abacus-network/abacus-sol/contracts/Outbox.sol";
import {XAppConnectionManager} from "@abacus-network/abacus-sol/contracts/XAppConnectionManager.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

abstract contract XAppConnectionClient is OwnableUpgradeable {
    // ============ Mutable Storage ============

    XAppConnectionManager public xAppConnectionManager;
    uint256[49] private __GAP; // gap for upgrade safety

    // ============ Modifiers ============

    /**
     * @notice Only accept messages from an Abacus Inbox contract
     */
    modifier onlyInbox() {
        require(_isInbox(msg.sender), "!inbox");
        _;
    }

    // ======== Initializer =========

    function __XAppConnectionClient_initialize(address _xAppConnectionManager)
        internal
        initializer
    {
        xAppConnectionManager = XAppConnectionManager(_xAppConnectionManager);
        __Ownable_init();
    }

    // ============ External functions ============

    /**
     * @notice Modify the contract the xApp uses to validate Inbox contracts
     * @param _xAppConnectionManager The address of the xAppConnectionManager contract
     */
    function setXAppConnectionManager(address _xAppConnectionManager)
        external
        onlyOwner
    {
        xAppConnectionManager = XAppConnectionManager(_xAppConnectionManager);
    }

    // ============ Internal functions ============

    /**
     * @notice Get the local Outbox contract from the xAppConnectionManager
     * @return The local Outbox contract
     */
    function _outbox() internal view returns (Outbox) {
        return xAppConnectionManager.outbox();
    }

    /**
     * @notice Determine whether _potentialReplcia is an enrolled Inbox from the xAppConnectionManager
     * @return True if _potentialInbox is an enrolled Inbox
     */
    function _isInbox(address _potentialInbox) internal view returns (bool) {
        return xAppConnectionManager.isInbox(_potentialInbox);
    }

    /**
     * @notice Get the local domain from the xAppConnectionManager
     * @return The local domain
     */
    function _localDomain() internal view virtual returns (uint32) {
        return xAppConnectionManager.localDomain();
    }
}
