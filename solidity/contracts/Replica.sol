// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "./Common.sol";

contract Replica is Common {
    uint32 public immutable ownSLIP44;
    uint256 public optimisticSeconds;

    bytes32 current;
    bytes32 pending;
    uint256 confirmAt;

    uint256 lastProcessed;

    event DoubleUpdate();

    constructor(
        uint32 _originSLIP44,
        uint32 _ownSLIP44,
        address _updater,
        uint256 _optimisticSeconds,
        bytes32 _start,
        uint256 _lastProcessed
    ) Common(_originSLIP44, _updater) {
        ownSLIP44 = _ownSLIP44;
        optimisticSeconds = _optimisticSeconds;
        current = _start;
        lastProcessed = _lastProcessed;
    }

    function fail() internal override {
        _setFailed();
    }

    function update(
        bytes32 _newRoot,
        bytes32 _oldRoot,
        bytes memory _signature
    ) external notFailed {
        require(current == _oldRoot, "Not current update");
        require(Common.checkSig(_newRoot, _oldRoot, _signature), "Bad sig");

        confirmAt = block.timestamp + optimisticSeconds;
        pending = _newRoot;
    }

    function confirm() external notFailed {
        require(confirmAt != 0, "No pending");
        require(block.timestamp >= confirmAt, "Not yet");
        current = pending;
        delete pending;
        delete confirmAt;
    }
}
