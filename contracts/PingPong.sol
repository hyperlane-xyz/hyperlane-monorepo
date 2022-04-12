// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============
import {Router} from "@abacus-network/app/contracts/Router.sol";

/*
============ PingPong ============
The PingPong app is capable of initiating PingPong "matches" between two chains.
A match consists of "volleys" sent back-and-forth between the two chains via Abacus.

The first volley in a match is always a Ping volley.
When a contract receives a Ping volley, it returns a Pong.
When a contract receives a Pong volley, it returns a Ping.

The contracts keep track of the number of volleys they've sent and received,
and emit events for each Sent and Received volley so that spectators can watch.
*/
contract PingPong is Router {
    uint256 public sent;
    uint256 public received;

    // ============ Events ============
    event Sent(uint32 indexed origin, uint32 indexed destination, bool isPing);

    event Received(
        uint32 indexed origin,
        uint32 indexed destination,
        bool isPing
    );

    // ============ Constructor ============
    constructor(address _connectionManager) {
        __Router_initialize(_connectionManager);
    }

    function pingRemote(uint32 _destination) external {
        _send(_destination, true);
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes memory _message
    ) internal override {
        received += 1;
        bool _isPing = abi.decode(_message, (bool));
        uint32 localDomain = _localDomain();
        emit Received(_origin, localDomain, _isPing);
        _send(_origin, !_isPing);
    }

    function _send(uint32 _destination, bool _isPing) internal {
        sent += 1;
        uint32 localDomain = _localDomain();
        bytes memory message = abi.encode(_isPing);
        _dispatchToRemoteRouter(_destination, message);
        emit Sent(localDomain, _destination, _isPing);
    }
}
