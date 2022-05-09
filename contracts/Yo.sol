// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============
import {Router} from "@abacus-network/app/contracts/Router.sol";

/*
============ Yo ============
The Yo app
*/
contract Yo is Router {
    uint256 public sent;
    uint256 public received;

    mapping(uint32 => uint256) public sentTo;
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

    function yoRemote(uint32 _destination) external {
        _send(_destination);
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes memory // _message
    ) internal override {
        received += 1;
        receivedFrom[_origin] += 1;
        uint32 localDomain = _localDomain();
        emit ReceivedYo(_origin, localDomain);
    }

    function _send(uint32 _destinationDomain) internal {
        sent += 1;
        sentTo[_destinationDomain] += 1;
        uint32 localDomain = _localDomain();
        _dispatchWithGasAndCheckpoint(_destinationDomain, "", 0);
        emit SentYo(localDomain, _destinationDomain);
    }
}
