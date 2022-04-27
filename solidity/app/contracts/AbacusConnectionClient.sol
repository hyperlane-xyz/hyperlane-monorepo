// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "@abacus-network/core/interfaces/IInterchainGasPaymaster.sol";
import {IOutbox} from "@abacus-network/core/interfaces/IOutbox.sol";
import {IAbacusConnectionManager} from "@abacus-network/core/interfaces/IAbacusConnectionManager.sol";

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

abstract contract AbacusConnectionClient is OwnableUpgradeable {
    // ============ Mutable Storage ============

    IAbacusConnectionManager public abacusConnectionManager;
    uint256[49] private __GAP; // gap for upgrade safety

    // ============ Events ============

    /**
     * @notice Emitted when a new abacusConnectionManager is set.
     * @param abacusConnectionManager The address of the abacusConnectionManager contract
     */
    event SetAbacusConnectionManager(address indexed abacusConnectionManager);

    // ============ Modifiers ============

    /**
     * @notice Only accept messages from an Abacus Inbox contract
     */
    modifier onlyInbox() {
        require(_isInbox(msg.sender), "!inbox");
        _;
    }

    // ======== Initializer =========

    function __AbacusConnectionClient_initialize(
        address _abacusConnectionManager
    ) internal {
        _setAbacusConnectionManager(_abacusConnectionManager);
        __Ownable_init();
    }

    // ============ External functions ============

    /**
     * @notice Modify the contract the Application uses to validate Inbox contracts
     * @param _abacusConnectionManager The address of the abacusConnectionManager contract
     */
    function setAbacusConnectionManager(address _abacusConnectionManager)
        external
        virtual
        onlyOwner
    {
        _setAbacusConnectionManager(_abacusConnectionManager);
    }

    // ============ Internal functions ============

    /**
     * @notice Modify the contract the Application uses to validate Inbox contracts
     * @param _abacusConnectionManager The address of the abacusConnectionManager contract
     */
    function _setAbacusConnectionManager(address _abacusConnectionManager)
        internal
    {
        abacusConnectionManager = IAbacusConnectionManager(
            _abacusConnectionManager
        );
        emit SetAbacusConnectionManager(_abacusConnectionManager);
    }

    /**
     * @notice Get the local Outbox contract from the abacusConnectionManager
     * @return The local Outbox contract
     */
    function _outbox() internal view returns (IOutbox) {
        return abacusConnectionManager.outbox();
    }

    /**
     * @notice Gets the local Interchain Gas Paymaster contract from the abacusConnectionManager.
     * @return The local Interchain Gas Paymaster contract.
     */
    function _interchainGasPaymaster()
        internal
        view
        returns (IInterchainGasPaymaster)
    {
        return abacusConnectionManager.interchainGasPaymaster();
    }

    /**
     * @notice Determine whether _potentialInbox is an enrolled Inbox from the abacusConnectionManager
     * @return True if _potentialInbox is an enrolled Inbox
     */
    function _isInbox(address _potentialInbox) internal view returns (bool) {
        return abacusConnectionManager.isInbox(_potentialInbox);
    }

    /**
     * @notice Get the local domain from the abacusConnectionManager
     * @return The local domain
     */
    function _localDomain() internal view virtual returns (uint32) {
        return abacusConnectionManager.localDomain();
    }
}
