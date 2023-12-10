// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";

// TODO: figure out whether it is possible to import this using Hardhat:
// https://github.com/wormhole-foundation/wormhole/blob/main/ethereum/contracts/interfaces/IWormhole.sol
interface IWormhole {
    function publishMessage(
        uint32 nonce,
        bytes memory payload,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence);
}

contract WormholeHook is IPostDispatchHook {
    IWormhole public wormhole;

    constructor(address _wormhole) {
        wormhole = IWormhole(_wormhole);
    }

    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.Types.WORMHOLE);
    }

    function supportsMetadata(bytes calldata) external pure returns (bool) {
        return false;
    }

    function postDispatch(
        bytes calldata,
        bytes calldata message
    ) external payable {
        wormhole.publishMessage{value: msg.value}(0, message, 200);
    }

    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure returns (uint256) {
        return 0;
    }
}
