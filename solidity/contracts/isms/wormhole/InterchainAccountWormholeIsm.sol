// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractWormholeIsm} from "./AbstractWormholeIsm.sol";
import {Message} from "../../libs/Message.sol";
import {InterchainAccountMessage} from "../../libs/middleware/InterchainAccountMessage.sol";

contract InterchainAccountWormholeIsm is AbstractWormholeIsm {
    constructor(
        address _wormhole,
        uint16[] memory _chainIds,
        uint32[] memory _domainIds,
        bytes32[] memory _emitters
    ) AbstractWormholeIsm(_wormhole, _chainIds, _domainIds, _emitters) {}

    function emitter(bytes calldata _message)
        internal
        view
        virtual
        override
        returns (bytes32)
    {
        // We expect the sender of the hook to be the same as the
        // owner of the interchain account
        return InterchainAccountMessage.owner(Message.body(_message));
    }
}
