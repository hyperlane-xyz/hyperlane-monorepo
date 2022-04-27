// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {AbacusConnectionClient} from "./AbacusConnectionClient.sol";
import {IAbacusConnectionManager} from "@abacus-network/core/interfaces/IAbacusConnectionManager.sol";
import {IMessageRecipient} from "@abacus-network/core/interfaces/IMessageRecipient.sol";
import {IOutbox} from "@abacus-network/core/interfaces/IOutbox.sol";

abstract contract Router is AbacusConnectionClient, IMessageRecipient {
    // ============ Mutable Storage ============

    mapping(uint32 => bytes32) public routers;
    uint256[49] private __GAP; // gap for upgrade safety

    // ============ Events ============

    /**
     * @notice Emitted when a router is set.
     * @param domain The domain of the new router
     * @param router The address of the new router
     */
    event EnrollRemoteRouter(uint32 indexed domain, bytes32 indexed router);

    // ============ Modifiers ============
    /**
     * @notice Only accept messages from a remote Router contract
     * @param _origin The domain the message is coming from
     * @param _router The address the message is coming from
     */
    modifier onlyRemoteRouter(uint32 _origin, bytes32 _router) {
        require(_isRemoteRouter(_origin, _router), "!router");
        _;
    }

    // ======== Initializer =========

    function __Router_initialize(address _abacusConnectionManager) internal {
        __AbacusConnectionClient_initialize(_abacusConnectionManager);
    }

    // ============ External functions ============

    /**
     * @notice Register the address of a Router contract for the same Application on a remote chain
     * @param _domain The domain of the remote Application Router
     * @param _router The address of the remote Application Router
     */
    function enrollRemoteRouter(uint32 _domain, bytes32 _router)
        external
        virtual
        onlyOwner
    {
        _enrollRemoteRouter(_domain, _router);
    }

    /**
     * @notice Handles an incoming message
     * @param _origin The origin domain
     * @param _sender The sender address
     * @param _message The message
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes memory _message
    ) external virtual override onlyInbox onlyRemoteRouter(_origin, _sender) {
        // TODO: callbacks on success/failure
        _handle(_origin, _sender, _message);
    }

    // ============ Virtual functions ============
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes memory _message
    ) internal virtual;

    // ============ Internal functions ============

    /**
     * @notice Set the router for a given domain
     * @param _domain The domain
     * @param _router The new router
     */
    function _enrollRemoteRouter(uint32 _domain, bytes32 _router) internal {
        routers[_domain] = _router;
        emit EnrollRemoteRouter(_domain, _router);
    }

    /**
     * @notice Return true if the given domain / router is the address of a remote Application Router
     * @param _domain The domain of the potential remote Application Router
     * @param _router The address of the potential remote Application Router
     */
    function _isRemoteRouter(uint32 _domain, bytes32 _router)
        internal
        view
        returns (bool)
    {
        return routers[_domain] == _router;
    }

    /**
     * @notice Assert that the given domain has a Application Router registered and return its address
     * @param _domain The domain of the chain for which to get the Application Router
     * @return _router The address of the remote Application Router on _domain
     */
    function _mustHaveRemoteRouter(uint32 _domain)
        internal
        view
        returns (bytes32 _router)
    {
        _router = routers[_domain];
        require(_router != bytes32(0), "!router");
    }

    /**
     * @notice Dispatches a message to an enrolled router via the local router's
     * Outbox
     * @dev Reverts if there is no enrolled router for _destination
     * @param _destination The domain of the chain to which to send the message
     * @param _msg The message to dispatch
     */
    function _dispatchToRemoteRouter(uint32 _destination, bytes memory _msg)
        internal
        returns (uint256)
    {
        // ensure that destination chain has enrolled router
        bytes32 _router = _mustHaveRemoteRouter(_destination);
        return _outbox().dispatch(_destination, _router, _msg);
    }

    /**
     * @notice Pay for message processing on the destination
     * @param _leafIndex The leaf index of the message to pay processing for
     * @param _gasPayment The amount of native tokens to pay the Interchain Gas
     * Paymaster to process the dispatched message.
     */
    function _payForGas(uint256 _leafIndex, uint256 _gasPayment) internal {
        _interchainGasPaymaster().payGasFor{value: _gasPayment}(_leafIndex);
    }

    /**
     * @notice Calls #checkpoint on the Outbox
     */
    function _checkpointOnOutbox() internal {
        _outbox().checkpoint();
    }

    /**
     * @notice A convenience function which allows the caller to 1) send a message
     * to the enrolled router on _destination as specified on the ACM, 2) pay
     * for message processing on the destination chain and 3) checkpoint the
     * message on the Outbox
     * @param _destination The domain of the chain to which to send the message.
     * @param _msg The message to dispatch.
     * @param _gasPayment The amount of native tokens to pay the Interchain Gas
     * Paymaster to process the dispatched message.
     * @param _shouldCheckpoint Whether checkpoint should be called on the Outbox
     */
    function _comboDispatch(
        uint32 _destination,
        bytes memory _msg,
        uint256 _gasPayment,
        bool _shouldCheckpoint
    ) internal {
        IAbacusConnectionManager _abacusConnectionManager = abacusConnectionManager;
        IOutbox _outboxVar = _abacusConnectionManager.outbox();
        bytes32 _router = _mustHaveRemoteRouter(_destination);
        uint256 leafIndex = _outboxVar.dispatch(_destination, _router, _msg);
        if (_gasPayment > 0) {
            _abacusConnectionManager.interchainGasPaymaster().payGasFor{
                value: _gasPayment
            }(leafIndex);
        }
        if (_shouldCheckpoint) {
            _outboxVar.checkpoint();
        }
    }
}
