// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "@openzeppelin/contracts/cryptography/ECDSA.sol";

contract Replica {
    enum States {WAITING, FAILED}

    States public state;

    uint32 public immutable originSLIP44;
    uint32 public immutable ownSLIP44;
    bytes32 public immutable DOMAIN_HASH;
    address public updater;
    uint256 public optimisticSeconds;

    bytes32 current;
    bytes32 pending;
    uint256 confirmAt;

    event DoubleUpdate();

    modifier notFailed() {
        require(state == States.WAITING);
        _;
    }

    constructor(
        uint32 _originSLIP44,
        uint32 _ownSLIP44,
        address _updater,
        uint256 _optimisticSeconds,
        bytes32 _start
    ) {
        DOMAIN_HASH = keccak256(abi.encodePacked(_originSLIP44, "OPTICS"));
        updater = _updater;
        originSLIP44 = _originSLIP44;
        ownSLIP44 = _ownSLIP44;
        state = States.WAITING;
        optimisticSeconds = _optimisticSeconds;
        current = _start;
    }

    function fail() internal {
        state = States.FAILED;
    }

    function checkSig(
        bytes32 _newRoot,
        bytes32 _oldRoot,
        bytes memory _signature
    ) internal view returns (bool) {
        bytes32 _digest =
            keccak256(abi.encodePacked(DOMAIN_HASH, _oldRoot, _newRoot));
        _digest = ECDSA.toEthSignedMessageHash(_digest);
        return ECDSA.recover(_digest, _signature) == updater;
    }

    function update(
        bytes32 _newRoot,
        bytes32 _oldRoot,
        bytes memory _signature
    ) external notFailed {
        require(current == _oldRoot, "Not current update");
        require(checkSig(_newRoot, _oldRoot, _signature), "Bad sig");

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

    function doubleUpdate(
        bytes32[2] calldata _newRoot,
        bytes32[2] calldata _oldRoot,
        bytes calldata _signature,
        bytes calldata _signature2
    ) external notFailed {
        if (
            checkSig(_newRoot[0], _oldRoot[0], _signature) &&
            checkSig(_newRoot[1], _oldRoot[1], _signature2) &&
            (_newRoot[0] != _newRoot[1] || _oldRoot[0] != _oldRoot[1])
        ) {
            fail();
            emit DoubleUpdate();
        }
    }
}
