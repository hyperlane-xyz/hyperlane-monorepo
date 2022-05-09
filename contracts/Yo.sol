// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============
import {Router} from "@abacus-network/app/contracts/Router.sol";

/*
============ Yo ============
The Yo app
*/
contract Yo is Router {
    // A counter of how many Yo messages have been sent from this contract.
    uint256 public sent;
    // A counter of how many Yo message have been received by this contract.
    uint256 public received;

    // Keyed by domain, a counter of how many Yo messages that have been sent
    // from this contract to the domain.
    mapping(uint32 => uint256) public sentTo;
    // Keyed by domain, a counter of how many Yo messages that have been received
    // by this contract from the domain.
    mapping(uint32 => uint256) public receivedFrom;

    // ============ Events ============
    event SentYo(uint32 indexed origin, uint32 indexed destination);
    event ReceivedYo(uint32 indexed origin, uint32 indexed destination);

    // ============ Constructor ============

    constructor() {}

    // ============ Initializer ============

    function initialize(address _abacusConnectionManager) external initializer {
        __Router_initialize(_abacusConnectionManager);
    }

    // ============ External functions ============

    /**
     * @notice Sends a Yo message to the _destinationDomain. Any msg.value is
     * used as interchain gas payment.
     * @param _destinationDomain The destination domain to send the Yo to.
     */
    function yoRemote(uint32 _destinationDomain) external payable {
        _send(_destinationDomain);
    }

    // ============ Internal functions ============

    /**
     * @notice Handles a Yo message from a remote router.
     * @dev Only called for messages sent from a remote router, as enforced by Router.sol.
     * @param _origin The domain of the origin of the message.
     * @param _sender The sender of the message.
     * @param _message The message body.
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes memory _message
    ) internal override {
        // Silence compiler - treat every incoming message as a Yo.
        _sender;
        _message;

        received += 1;
        receivedFrom[_origin] += 1;
        emit ReceivedYo(_origin, _localDomain());
    }

    /**
     * @notice Sends a Yo message to the _destinationDomain. Any msg.value is
     * used as interchain gas payment.
     * @param _destinationDomain The destination domain to send the Yo to.
     */
    function _send(uint32 _destinationDomain) internal {
        sent += 1;
        sentTo[_destinationDomain] += 1;
        _dispatchWithGasAndCheckpoint(_destinationDomain, "", msg.value);
        emit SentYo(_localDomain(), _destinationDomain);
    }
}
