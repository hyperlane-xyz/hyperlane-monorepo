// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "@openzeppelin/contracts/cryptography/ECDSA.sol";

abstract contract Common {
    enum States {ACTIVE, FAILED}

    uint32 public immutable originSLIP44;
    bytes32 public immutable DOMAIN_HASH;

    address public updater;
    States public state;
    bytes32 public current;

    event Update(
        bytes32 indexed _oldRoot,
        bytes32 indexed _newRoot,
        bytes signature
    );
    event DoubleUpdate(
        bytes32[2] _oldRoot,
        bytes32[2] _newRoot,
        bytes _signature,
        bytes _signature2
    );

    constructor(
        uint32 _originSLIP44,
        address _updater,
        bytes32 _current
    ) {
        originSLIP44 = _originSLIP44;
        updater = _updater;
        current = _current;
        DOMAIN_HASH = keccak256(abi.encodePacked(_originSLIP44, "OPTICS"));
        state = States.ACTIVE;
    }

    function fail() internal virtual;

    function _setFailed() internal {
        state = States.FAILED;
    }

    modifier notFailed() {
        require(state != States.FAILED);
        _;
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

    function doubleUpdate(
        bytes32[2] calldata _newRoot,
        bytes32[2] calldata _oldRoot,
        bytes calldata _signature,
        bytes calldata _signature2
    ) external notFailed {
        if (
            Common.checkSig(_newRoot[0], _oldRoot[0], _signature) &&
            Common.checkSig(_newRoot[1], _oldRoot[1], _signature2) &&
            (_newRoot[0] != _newRoot[1] || _oldRoot[0] != _oldRoot[1])
        ) {
            fail();
            emit DoubleUpdate(_oldRoot, _newRoot, _signature, _signature2);
        }
    }
}
