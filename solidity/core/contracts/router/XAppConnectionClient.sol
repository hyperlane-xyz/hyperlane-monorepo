// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "../../interfaces/IInterchainGasPaymaster.sol";
import {Outbox} from "../Outbox.sol";
import {XAppConnectionManager} from "../XAppConnectionManager.sol";
// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

abstract contract XAppConnectionClient is OwnableUpgradeable {
    // ============ Mutable Storage ============

    XAppConnectionManager public xAppConnectionManager;
    uint256[49] private __GAP; // gap for upgrade safety

    // ============ Events ============

    /**
     * @notice Emitted when a new xAppConnectionManager is set.
     * @param xAppConnectionManager The address of the xAppConnectionManager contract
     */
    event SetXAppConnectionManager(address indexed xAppConnectionManager);

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
        virtual
        onlyOwner
    {
        _setXAppConnectionManager(_xAppConnectionManager);
    }

    // ============ Internal functions ============

    /**
     * @notice Modify the contract the xApp uses to validate Inbox contracts
     * @param _xAppConnectionManager The address of the xAppConnectionManager contract
     */
    function _setXAppConnectionManager(address _xAppConnectionManager)
        internal
    {
        xAppConnectionManager = XAppConnectionManager(_xAppConnectionManager);
        emit SetXAppConnectionManager(_xAppConnectionManager);
    }

    /**
     * @notice Get the local Outbox contract from the xAppConnectionManager
     * @return The local Outbox contract
     */
    function _outbox() internal view returns (Outbox) {
        return xAppConnectionManager.outbox();
    }

    /**
     * @notice Gets the local Interchain Gas Paymaster contract from the xAppConnectionManager.
     * @return The local Interchain Gas Paymaster contract.
     */
    function _interchainGasPaymaster() internal view returns (IInterchainGasPaymaster) {
        return xAppConnectionManager.interchainGasPaymaster();
    }

    /**
     * @notice Determine whether _potentialInbox is an enrolled Inbox from the xAppConnectionManager
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
