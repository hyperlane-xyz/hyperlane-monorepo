// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IWormholeMessageHook} from "../interfaces/hooks/IWormholeMessageHook.sol";
import {IWormhole} from "../interfaces/IWormhole.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

contract WormholeMessageHook is IWormholeMessageHook {
    IWormhole immutable wormhole;
    uint8 immutable consistencyLevel;

    constructor(IWormhole _wormhole, uint8 _consistencyLevel) {
        wormhole = _wormhole;
        consistencyLevel = _consistencyLevel;
    }

    function postDispatch(uint32 _destination, bytes32 _messageId)
        external
        returns (uint256)
    {
        bytes32 _payload = keccak256(
            abi.encodePacked(TypeCasts.addressToBytes32(msg.sender), _messageId)
        );
        uint32 _nonce = 0;
        // TODO: Is nonce of 0 safe
        uint64 _sequence = wormhole.publishMessage(
            _nonce,
            abi.encodePacked(_payload),
            consistencyLevel
        );
        emit WormholeMessagePublished(_payload, _nonce, _sequence);
        // TODO: gas table
        return 0;
    }
}
