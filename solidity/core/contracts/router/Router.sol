// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {XAppConnectionClient} from "./XAppConnectionClient.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

abstract contract Router is XAppConnectionClient, IMessageRecipient {
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

    // ============ External functions ============

    /**
     * @notice Register the address of a Router contract for the same xApp on a remote chain
     * @param _domain The domain of the remote xApp Router
     * @param _router The address of the remote xApp Router
     */
    function enrollRemoteRouter(uint32 _domain, bytes32 _router)
        external
        virtual
        onlyOwner
    {
        _enrollRemoteRouter(_domain, _router);
    }

    // ============ Virtual functions ============

    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes memory _message
    ) external virtual override;

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
     * @notice Return true if the given domain / router is the address of a remote xApp Router
     * @param _domain The domain of the potential remote xApp Router
     * @param _router The address of the potential remote xApp Router
     */
    function _isRemoteRouter(uint32 _domain, bytes32 _router)
        internal
        view
        returns (bool)
    {
        return routers[_domain] == _router;
    }

    /**
     * @notice Assert that the given domain has a xApp Router registered and return its address
     * @param _domain The domain of the chain for which to get the xApp Router
     * @return _router The address of the remote xApp Router on _domain
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
     * @notice Dispatches a message to an enrolled router via the local routers
     * Outbox
     * @dev Reverts if there is no enrolled router for _destination
     * @param _destination The domain of the chain to which to send the message
     * @param _msg The message to dispatch
     */
    function _dispatchToRemoteRouter(uint32 _destination, bytes memory _msg)
        internal
    {
        // ensure that destination chain has enrolled router
        bytes32 _router = _mustHaveRemoteRouter(_destination);
        _outbox().dispatch(_destination, _router, _msg);
    }

    /**
     * @notice Dispatches a message to an enrolled router via the local router's
     * Outbox and pays native tokens for the processing on the destination chain using
     * the Interchain Gas Paymaster.
     * @dev Reverts if there is no enrolled router for _destination
     * @param _destination The domain of the chain to which to send the message
     * @param _msg The message to dispatch
     * @param _paymentAmount The amount of native tokens to pay the Interchain Gas
     * Paymaster to process the dispatched message.
     */
    function _dispatchToRemoteRouterAndPayForGas(
        uint32 _destination,
        bytes memory _msg,
        uint256 _paymentAmount
    ) internal {
        // ensure that destination chain has enrolled router
        bytes32 _router = _mustHaveRemoteRouter(_destination);
        uint256 leafIndex = _outbox().dispatch(_destination, _router, _msg);
        _interchainGasPaymaster().payGasFor{value: _paymentAmount}(leafIndex);
    }
}
