// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "../../libs/Message.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";

// TODO: figure out whether it is possible to import this using Hardhat:
// https://github.com/wormhole-foundation/wormhole/blob/main/ethereum/contracts/interfaces/IWormhole.sol
interface IWormhole {
    function publishMessage(
        uint32 nonce,
        bytes memory payload,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence);
}

contract WormholeHook is IPostDispatchHook, MailboxClient {
    using Message for bytes;

    IWormhole public wormhole;

    constructor(address _wormhole, address _mailbox) MailboxClient(_mailbox) {
        wormhole = IWormhole(_wormhole);
    }

    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.Types.WORMHOLE);
    }

    function supportsMetadata(bytes calldata) external pure returns (bool) {
        return true;
    }

    function postDispatch(
        bytes calldata,
        bytes calldata message
    ) external payable {
        // ensure hook only dispatches messages that are dispatched by the mailbox
        bytes32 id = message.id();
        require(_isLatestDispatched(id), "message not dispatched by mailbox");
        // use 0 nonce, _isLatestDispatched is sufficient check.
        // 201 consistency level iis safest as it ensures finality is reached before bridging.
        wormhole.publishMessage{value: msg.value}(0, abi.encodePacked(id), 201);
    }

    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure returns (uint256) {
        return 0;
    }
}
